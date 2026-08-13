// TubeCLI Provisioner — nhận job qua HTTP, SSH vào server mới thuê,
// chạy install.sh chính thức của TubeCLI rồi callback kết quả về web.
// Deploy: docker container trên Zeabur (hoặc VPS bất kỳ).
const http = require('http');
const { Client } = require('ssh2');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.PROVISIONER_SECRET || '';
const TUBECLI_PORT = process.env.TUBECLI_PORT || '5295';

if (!SECRET) {
  console.error('Thiếu env PROVISIONER_SECRET — thoát.');
  process.exit(1);
}

// Token tunnel chỉ [A-Za-z0-9_-] (base64url của Cloudflare) — lọc để không chèn shell.
function safeToken(token) {
  return String(token || '').replace(/[^A-Za-z0-9_-]/g, '');
}

// Đoạn cài cloudflared tunnel (khi có token) — chạy như systemd service.
// Token KHÔNG được lộ vào log: chạy `cloudflared service install` trong subshell
// `set +x`. Tự chọn binary theo kiến trúc (amd64/arm64) và kiểm tra cài thành công.
function tunnelSnippet(token) {
  const tok = safeToken(token);
  if (!tok) return [];
  return [
    '# --- Cloudflare Tunnel ---',
    'if ! command -v cloudflared >/dev/null 2>&1; then',
    '  ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) CFARCH=arm64;; armv7l|armhf) CFARCH=arm;; *) CFARCH=amd64;; esac',
    '  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CFARCH}" -o /tmp/cloudflared',
    '  $SUDO install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared',
    'fi',
    'if ! command -v cloudflared >/dev/null 2>&1; then echo "[tunnel] CAI CLOUDFLARED THAT BAI"; else',
    '  $SUDO cloudflared service uninstall >/dev/null 2>&1 || true',
    // Token trong subshell không trace (set +x) — không lọt vào install_log
    `  ( set +x; $SUDO cloudflared service install ${tok} ) >/dev/null 2>&1 && echo "[tunnel] service installed" || echo "[tunnel] SERVICE INSTALL FAIL"`,
    '  $SUDO systemctl restart cloudflared || true',
    '  echo "===TUNNEL_DONE==="',
    'fi',
  ];
}

// Cho phép origin của trang cloud gọi API TubeCLI từ browser (origin guard):
// ghi systemd drop-in rồi restart service `tubecli`.
function originSnippet(hosts) {
  if (!hosts) return [];
  const safe = String(hosts).replace(/[^a-zA-Z0-9.,:-]/g, '');
  return [
    '# --- Origin allowlist cho trang cloud ---',
    '$SUDO mkdir -p /etc/systemd/system/tubecli.service.d',
    `printf '[Service]\\nEnvironment=TUBECLI_ALLOWED_ORIGIN_HOSTS=${safe}\\n' | $SUDO tee /etc/systemd/system/tubecli.service.d/cloud.conf >/dev/null`,
    '$SUDO systemctl daemon-reload || true',
    '$SUDO systemctl restart tubecli || true',
  ];
}

// Bảo đảm mật khẩu TubeCLI đã đổi khỏi mặc định. TUBECLI_PASSWORD env được
// `tubecli init --server` áp dụng sẵn; đoạn này là lưới an toàn cho bản cũ:
// nếu còn login được bằng 123456 thì đổi qua API loopback. Chạy trong subshell
// `set +x` để mật khẩu KHÔNG lọt vào log cài đặt.
function passwordSnippet(hasPassword) {
  if (!hasPassword) return [];
  // Chờ TubeCLI lên tới 3 phút (máy nhỏ + vừa restart bởi originSnippet).
  // Kiểm HTTP code THẬT ở cả login lẫn đổi mật khẩu; in marker để runJob phân biệt
  // 'đã áp mật khẩu' vs 'còn mặc định' (không đoán mò như trước).
  return [
    '# --- Xoay mật khẩu khỏi mặc định (log không chứa mật khẩu) ---',
    `for i in $(seq 1 90); do curl -fs http://127.0.0.1:${TUBECLI_PORT}/api/v1/health >/dev/null 2>&1 && break; sleep 2; done`,
    `( set +x; CK=$(mktemp); ` +
      `LC=$(curl -s -o /dev/null -w "%{http_code}" -c "$CK" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/login -H "Content-Type: application/json" -d '{"password":"123456"}'); ` +
      `NC=$(curl -s -o /dev/null -w "%{http_code}" -c "$CK" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/login -H "Content-Type: application/json" -d "{\\"password\\":\\"$TUBECLI_PASSWORD\\"}"); ` +
      `if [ "$NC" = "200" ]; then echo "===PW_OK=== (env applied)"; ` +
      `elif [ "$LC" = "200" ]; then ` +
        `PC=$(curl -s -o /dev/null -w "%{http_code}" -b "$CK" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/password -H "Content-Type: application/json" ` +
        `-d "{\\"current_password\\":\\"123456\\",\\"new_password\\":\\"$TUBECLI_PASSWORD\\"}"); ` +
        `if [ "$PC" = "200" ]; then echo "===PW_OK=== (rotated via api)"; else echo "===PW_FAIL=== (change http $PC)"; fi; ` +
      `else echo "===PW_FAIL=== (login default http $LC, env http $NC)"; fi; rm -f "$CK" )`,
  ];
}

// Lệnh cài: script chính thức 1 dòng, LUÔN chạy non-interactive (bỏ mọi bước
// hỏi bàn phím như "Choose language") — nếu không sẽ treo tới timeout.
function buildInstallCommand(lang, tunnelToken, tubecliPassword, originHosts) {
  const l = lang === 'en' ? 'en' : 'vi';
  // Nhiều máy cloud không cho root SSH → dùng ubuntu + sudo. $SUDO tự rỗng khi là root.
  const SUDO = 'SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo "sudo")';
  // Mật khẩu chỉ chứa [A-Za-z0-9] (genPassword phía worker) nhưng vẫn lọc lại cho chắc.
  const pw = String(tubecliPassword || '').replace(/[^A-Za-z0-9._-]/g, '');
  return [
    // Export TRƯỚC `set -x` để mật khẩu không bị echo vào install_log
    pw ? `export TUBECLI_PASSWORD='${pw}'` : 'true',
    'set -x',
    'set -o pipefail',   // curl fail trong `curl | bash` phải làm pipe fail
    'export DEBIAN_FRONTEND=noninteractive',
    'export TUBECLI_NONINTERACTIVE=1',
    SUDO,
    // Chờ apt lock (máy mới hay bận cloud-init)
    'for i in $(seq 1 30); do $SUDO fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; echo "cho apt lock..."; sleep 5; done',
    '$SUDO apt-get update -y || true',
    '$SUDO apt-get install -y curl || true',
    // Cài TubeCLI — non-interactive + ngôn ngữ cố định. TUBECLI_PASSWORD đã export
    // ở trên nên truyền xuyên qua install.sh → `tubecli init --server` tự áp dụng.
    // Bắt exit code THẬT của bước cài (echo INSTALL_RC) để provisioner không báo
    // nhầm thành công khi install.sh fail (GitHub 404, mạng hỏng, apt lỗi).
    'INSTALL_RC=0',
    `curl -fsSL https://raw.githubusercontent.com/tubecreate/tubecli/main/install.sh | bash -s -- --non-interactive --lang ${l} || INSTALL_RC=$?`,
    'echo "===INSTALL_RC=${INSTALL_RC}==="',
    // Các bước sau chỉ best-effort, không ảnh hưởng kết luận thành công của bước cài
    // Mở firewall nếu có ufw
    `command -v ufw >/dev/null 2>&1 && $SUDO ufw allow ${TUBECLI_PORT}/tcp || true`,
    ...originSnippet(originHosts),
    ...passwordSnippet(!!pw),
    ...tunnelSnippet(tunnelToken),
    `echo "===INSTALL_DONE==="`,
  ].join('\n');
}

// Chỉ cài tunnel (cho server đã có TubeCLI, user bấm Generate Domain sau)
function buildTunnelCommand(token) {
  const SUDO = 'SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo "sudo")';
  return [
    'set -x',
    SUDO,
    ...tunnelSnippet(token),
    `echo "===INSTALL_DONE==="`,
  ].join('\n');
}

// Chấm điểm output cài đặt (mode install):
//   ok  = install.sh chạy trọn với exit 0  (marker ===INSTALL_RC=0===)
//   pwOk = mật khẩu đã áp lên máy           (marker ===PW_OK===)
function scoreInstall(output) {
  const rc = output.match(/===INSTALL_RC=(\d+)===/);
  return {
    ok: !!rc && rc[1] === '0',
    installRc: rc ? Number(rc[1]) : null,
    pwOk: output.includes('===PW_OK==='),
    pwFail: output.includes('===PW_FAIL==='),
  };
}

function sshExec({ ip, port, username, password, command, mode, timeoutMs = 15 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let output = '';
    let connected = false; // đã mở được phiên SSH chưa (để phân biệt lỗi mạng vs lỗi cài)
    let settled = false;
    const finish = (ok, extra = '') => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      resolve({ ok, connected, output: output + (extra ? `\n${extra}` : '') });
    };
    const timer = setTimeout(() => finish(false, `[provisioner] Timeout sau ${timeoutMs / 60000} phút`), timeoutMs);

    conn.on('ready', () => {
      connected = true;
      conn.exec(command, { pty: true }, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(false, `exec error: ${err.message}`); }
        stream.on('data', (d) => { output += d.toString(); if (output.length > 200000) output = output.slice(-150000); });
        stream.stderr.on('data', (d) => { output += d.toString(); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          let ok;
          if (mode === 'tunnel') {
            ok = output.includes('===TUNNEL_DONE===');
          } else {
            ok = scoreInstall(output).ok; // CHỈ dựa exit code thật của install.sh
          }
          finish(ok, `[exit code: ${code}]`);
        });
      });
    });
    conn.on('error', (e) => { clearTimeout(timer); finish(false, `ssh error: ${e.message}`); });
    conn.connect({
      host: ip, port: Number(port) || 22, username: username || 'root', password,
      readyTimeout: 30000, keepaliveInterval: 10000,
    });
  });
}

// Retry CHỈ khi chưa mở được phiên SSH (máy mới chưa bật sshd). Đã vào được SSH mà
// cài lỗi thì KHÔNG chạy lại (tránh cài chồng nhiều lần vì một dòng log vô hại).
async function sshExecWithRetry(job, tries = 5) {
  let last = { ok: false, connected: false, output: '' };
  for (let i = 1; i <= tries; i++) {
    last = await sshExec(job);
    if (last.ok || last.connected) return last;
    const wait = 20000 * i;
    console.log(`[job] SSH chưa vào được (lần ${i}/${tries}), chờ ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

async function runJob(job) {
  const mode = job.mode === 'tunnel' ? 'tunnel' : 'install';
  console.log(`[job ${job.ref}] Bắt đầu (${mode}) trên ${job.ip}`);
  const command = mode === 'tunnel'
    ? buildTunnelCommand(job.tunnel_token)
    : buildInstallCommand(job.lang, job.tunnel_token, job.tubecli_password, job.origin_hosts);
  const result = await sshExecWithRetry({ ...job, command, mode });

  const tubecliUrl = `http://${job.ip}:${TUBECLI_PORT}`;
  // Xác minh TubeCLI đã lên (tối đa 2 phút) — bỏ qua với mode tunnel.
  // /api/v1/health là endpoint tồn tại thật và được miễn auth.
  let alive = mode === 'tunnel';
  if (result.ok && mode !== 'tunnel') {
    for (let i = 0; i < 12; i++) {
      try {
        const res = await fetch(`${tubecliUrl}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { alive = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Thành công = install.sh exit 0 (marker ===INSTALL_RC=0===). pw_ok cho web biết
  // mật khẩu ngẫu nhiên đã thực sự áp lên máy hay chưa (để xử lý lệch D1).
  const score = mode === 'install' ? scoreInstall(result.output) : { pwOk: true, pwFail: false };
  const payload = {
    secret: SECRET,
    ref: job.ref,
    mode,
    ok: result.ok,
    pw_ok: mode === 'install' ? (job.tubecli_password ? score.pwOk : null) : null,
    tubecli_url: result.ok ? tubecliUrl : '',
    log: result.output.slice(-18000) + (result.ok && !alive && mode === 'install'
      ? '\n[provisioner] Lưu ý: chưa xác nhận cổng ' + TUBECLI_PORT + ' từ bên ngoài. Nếu không mở được dashboard, kiểm tra firewall/security group của VPS đã mở TCP ' + TUBECLI_PORT + '.'
      : '')
      + (mode === 'install' && score.pwFail ? '\n[provisioner] CẢNH BÁO: chưa đổi được mật khẩu TubeCLI khỏi mặc định.' : ''),
  };

  if (job.callback) {
    try {
      const res = await fetch(job.callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      console.log(`[job ${job.ref}] Callback → ${res.status}`);
    } catch (e) {
      console.error(`[job ${job.ref}] Callback lỗi: ${e.message}`);
    }
  }
  console.log(`[job ${job.ref}] Xong: ok=${payload.ok}`);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && req.url === '/install') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      try {
        const job = JSON.parse(body);
        if (job.secret !== SECRET) {
          res.writeHead(401); return res.end('unauthorized');
        }
        if (!job.ip || !job.password || !job.ref) {
          res.writeHead(400); return res.end('thiếu ip/password/ref');
        }
        // Chạy nền, trả 202 ngay
        runJob(job).catch((e) => console.error(`[job ${job.ref}] crash:`, e));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      } catch (e) {
        res.writeHead(400); res.end('bad json');
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`TubeCLI Provisioner lắng nghe :${PORT}`));
