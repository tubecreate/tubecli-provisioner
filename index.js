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

// Token tunnel cloudflared là base64 CHUẨN của JSON → chứa cả '+', '/', '='.
// TUYỆT ĐỐI không strip mấy ký tự này (từng làm hỏng token → tunnel chết). Chỉ giữ
// đúng bộ ký tự base64 (std + url); token được truyền trong dấu nháy đơn nên an toàn shell.
function safeToken(token) {
  return String(token || '').replace(/[^A-Za-z0-9+/=_.-]/g, '');
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
    // FIX TRIỆT ĐỂ (14/8): service unit của cloudflared chạy `--token-file /etc/cloudflared/token`.
    // Từng mất tunnel vì `service install` báo "already installed" nên KHÔNG ghi token, mà
    // file token lại bị xoá ở đâu đó → restart exit 255. Giải: LUÔN tự ghi token file
    // (không phụ thuộc service install), chỉ install unit khi CHƯA có, KHÔNG teardown.
    '  $SUDO mkdir -p /etc/cloudflared',
    '  if [ ! -f /etc/systemd/system/cloudflared.service ]; then',
    `    ( set +x; $SUDO cloudflared service install '${tok}' >/tmp/cf_install.log 2>&1 ) && echo "[tunnel] service installed" || { echo "[tunnel] install warn:"; grep -vi token /tmp/cf_install.log | tail -3; }`,
    '  else echo "[tunnel] service unit da co — chi ghi lai token"; fi',
    // Ghi token đúng (subshell set +x để không lộ token vào log) — bước quyết định
    `  ( set +x; printf '%s' '${tok}' | $SUDO tee /etc/cloudflared/token >/dev/null )`,
    '  $SUDO chmod 600 /etc/cloudflared/token',
    '  $SUDO systemctl enable cloudflared >/dev/null 2>&1 || true',
    '  $SUDO systemctl restart cloudflared 2>/dev/null || $SUDO systemctl start cloudflared 2>/dev/null || true',
    // Xác minh thật sự: service phải active thì mới coi là xong
    '  sleep 3',
    '  if systemctl is-active cloudflared >/dev/null 2>&1; then echo "[tunnel] service ACTIVE"; else',
    '    echo "[tunnel] restart loi, cai lai sach:"; $SUDO journalctl -u cloudflared --no-pager -n 3 2>&1 | grep -vi token | tail -3',
    '    $SUDO cloudflared service uninstall >/dev/null 2>&1 || true; $SUDO rm -f /etc/systemd/system/cloudflared*.service /etc/systemd/system/cloudflared*.timer; $SUDO systemctl daemon-reload || true; sleep 2',
    `    ( set +x; $SUDO cloudflared service install '${tok}' >/dev/null 2>&1 )`,
    '    $SUDO systemctl enable --now cloudflared 2>/dev/null || true; sleep 3',
    '    systemctl is-active cloudflared >/dev/null 2>&1 && echo "[tunnel] service ACTIVE (sau cai sach)" || echo "[tunnel] SERVICE KHONG CHAY"',
    '  fi',
    '  echo "===TUNNEL_DONE==="',
    'fi',
  ];
}

// Dependency cho browser engine (ShardX live-view/fingerprint):
// - Node.js: /browser/view preview server bắt buộc có `node` (browser/routes.py:1260)
// - Thư viện hệ thống: đúng danh sách _APT_ALTERNATIVES của shardx_runtime.py —
//   cài TỪNG gói với tên thay thế (Ubuntu 24.04 đổi tên t64: libasound2 thành
//   virtual package làm apt fail CẢ transaction nếu cài gộp), gói hỏng chỉ mất chính nó.
function browserDepsSnippet() {
  const pkgs = [
    'unzip', 'ca-certificates', 'fonts-liberation', 'libnss3', 'libnspr4',
    'libatk1.0-0t64|libatk1.0-0', 'libatk-bridge2.0-0t64|libatk-bridge2.0-0',
    'libcups2t64|libcups2', 'libxkbcommon0', 'libxcomposite1', 'libxdamage1',
    'libxfixes3', 'libxrandr2', 'libgbm1', 'libpango-1.0-0', 'libcairo2',
    'libasound2t64|libasound2', 'libxshmfence1',
  ];
  return [
    '# --- Browser engine deps (Node.js + thu vien ShardX) ---',
    // nodejs cài MỘT MÌNH: bản NodeSource đã kèm npm, cài gộp "nodejs npm" làm gói npm
    // của Ubuntu kéo chuỗi node-* xung đột → apt "held broken packages" huỷ cả transaction.
    'command -v node >/dev/null 2>&1 || $SUDO apt-get install -y nodejs || true',
    'command -v npm >/dev/null 2>&1 || $SUDO apt-get install -y npm || true',
    `for p in ${pkgs.map((p) => `"${p}"`).join(' ')}; do`,
    '  OK=0',
    '  for a in $(echo "$p" | tr "|" " "); do $SUDO apt-get install -y "$a" >/dev/null 2>&1 && OK=1 && break; done',
    '  [ "$OK" = "1" ] || echo "[browser-deps] khong cai duoc: $p"',
    'done',
    'command -v node >/dev/null 2>&1 && echo "[browser-deps] node $(node --version)" || echo "[browser-deps] NODE VAN THIEU"',
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
    `( set +x; CK=$(mktemp); CK2=$(mktemp); ` +
      // Jar RIÊNG cho mỗi lần login: nếu login mật khẩu mới thất bại (bản cũ) thì
      // KHÔNG ghi đè jar 123456 dùng cho bước đổi mật khẩu bên dưới.
      `LC=$(curl -s -o /dev/null -w "%{http_code}" -c "$CK" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/login -H "Content-Type: application/json" -d '{"password":"123456"}'); ` +
      `NC=$(curl -s -o /dev/null -w "%{http_code}" -c "$CK2" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/login -H "Content-Type: application/json" -d "{\\"password\\":\\"$TUBECLI_PASSWORD\\"}"); ` +
      `if [ "$NC" = "200" ]; then echo "===PW_OK=== (env applied)"; ` +
      `elif [ "$LC" = "200" ]; then ` +
        `PC=$(curl -s -o /dev/null -w "%{http_code}" -b "$CK" -X POST http://127.0.0.1:${TUBECLI_PORT}/api/v1/auth/password -H "Content-Type: application/json" ` +
        `-d "{\\"current_password\\":\\"123456\\",\\"new_password\\":\\"$TUBECLI_PASSWORD\\"}"); ` +
        `if [ "$PC" = "200" ]; then echo "===PW_OK=== (rotated via api)"; else echo "===PW_FAIL=== (change http $PC)"; fi; ` +
      `else echo "===PW_FAIL=== (login default http $LC, env http $NC)"; fi; rm -f "$CK" "$CK2" )`,
  ];
}

// Lệnh cài: script chính thức 1 dòng, LUÔN chạy non-interactive (bỏ mọi bước
// hỏi bàn phím như "Choose language") — nếu không sẽ treo tới timeout.
function buildInstallCommand(lang, tunnelToken, tubecliPassword, originHosts) {
  // Khớp SUPPORTED_LANGUAGES của TubeCLI (install.sh validate cùng danh sách)
  const TUBECLI_LANGS = ['zh', 'zh-TW', 'vi', 'en', 'ja', 'ko', 'es', 'tr', 'ru'];
  const l = TUBECLI_LANGS.includes(lang) ? lang : 'en';
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
    // Font cho trình duyệt (ShardX) — phủ đa ngôn ngữ để tránh chữ □ tofu:
    // CJK (Nhật/Trung/Hàn) + emoji + Noto core (Ả Rập, Thái, Hebrew, Devanagari, Cyrillic…)
    // + Thái/Ả Rập chuyên biệt + font phổ biến (Liberation ~ Arial/Times, DejaVu, FreeFont).
    '$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y '
      + 'fonts-noto-cjk fonts-noto-color-emoji fonts-noto-core fonts-noto-ui-core '
      + 'fonts-thai-tlwg fonts-kacst fonts-freefont-ttf fonts-liberation fonts-dejavu-core || true',
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
    ...browserDepsSnippet(),
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

// Đổi mật khẩu SSH rồi TỰ KIỂM bằng cách đăng nhập lại bằng mật khẩu mới.
//
// Mật khẩu đi qua STDIN của chpasswd, không qua dòng lệnh: argv đọc được bằng
// `ps` từ mọi user trên máy đó. `sudo -n` để không bao giờ treo chờ nhập mật
// khẩu — image cloud cấp NOPASSWD cho user mặc định (chính bước cài TubeCLI đã
// dựa vào điều đó), thiếu thì trả lỗi rõ ràng thay vì đứng im tới timeout.
function sshChangePassword({ ip, port, username, password, newPassword, alsoRoot }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { conn.end(); } catch {}
      resolve({ ok, error });
    };
    const timer = setTimeout(() => finish(false, 'timeout khi đổi mật khẩu'), 60000);
    conn.on('ready', () => {
      // chpasswd đọc "user:password" từng dòng. Không pty: cần stdin sạch.
      const cmd = 'SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo "sudo -n"); $SUDO chpasswd';
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(false, `exec error: ${err.message}`); }
        let out = '';
        stream.on('data', (d) => { out += d.toString(); });
        stream.stderr.on('data', (d) => { out += d.toString(); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) return finish(true, '');
          const hint = /password is required|sudo:/i.test(out)
            ? 'user SSH không có quyền sudo không mật khẩu (NOPASSWD) nên không đổi được'
            : (out.trim().slice(-300) || `chpasswd thoát mã ${code}`);
          finish(false, hint);
        });
        stream.write(`${username}:${newPassword}\n`);
        if (alsoRoot && username !== 'root') stream.write(`root:${newPassword}\n`);
        stream.end();
      });
    });
    conn.on('error', (e) => { clearTimeout(timer); finish(false, `ssh error: ${e.message}`); });
    conn.connect({
      host: ip, port: Number(port) || 22, username: username || 'root', password,
      readyTimeout: 20000, keepaliveInterval: 10000,
    });
  });
}

// Đăng nhập thử — dùng để XÁC MINH mật khẩu mới thật sự dùng được.
function sshCanLogin({ ip, port, username, password }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { conn.end(); } catch {}
      resolve({ ok, error });
    };
    const timer = setTimeout(() => finish(false, 'timeout khi đăng nhập thử'), 30000);
    conn.on('ready', () => { clearTimeout(timer); finish(true, ''); });
    conn.on('error', (e) => { clearTimeout(timer); finish(false, e.message); });
    conn.connect({
      host: ip, port: Number(port) || 22, username: username || 'root', password,
      readyTimeout: 20000,
    });
  });
}

async function rotateSshPassword(job) {
  const { ip, port, username, password, new_password: newPassword } = job;
  // chpasswd tách dòng bằng ":" và "\n" — mật khẩu chứa chúng sẽ hỏng câm.
  if (!newPassword || newPassword.length < 12 || /[:\r\n\s]/.test(newPassword)) {
    return { ok: false, error: 'mật khẩu mới không hợp lệ (>=12 ký tự, không chứa ":" hay khoảng trắng)' };
  }
  const changed = await sshChangePassword({
    ip, port, username, password, newPassword, alsoRoot: !!job.also_root,
  });
  if (!changed.ok) return { ok: false, error: changed.error, stage: 'change' };

  // Đổi xong mới là một nửa: phải VÀO ĐƯỢC bằng mật khẩu mới thì mới dám báo
  // thành công, kẻo cloud lưu một mật khẩu không mở được cửa nào.
  const check = await sshCanLogin({ ip, port, username, password: newPassword });
  if (!check.ok) return { ok: false, error: `đổi rồi nhưng không đăng nhập lại được: ${check.error}`, stage: 'verify' };
  return { ok: true };
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

// ── Realtime stats: SSH đọc /proc một phát, tính CPU%/RAM/Disk ────────────────
function parseStats(out) {
  try {
    const g = (re) => (out.match(re) || [])[1] || '';
    const n1 = g(/S1:cpu\s+(.+)/).trim().split(/\s+/).map(Number);
    const n2 = g(/S2:cpu\s+(.+)/).trim().split(/\s+/).map(Number);
    const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
    const t1 = sum(n1), t2 = sum(n2);
    const i1 = (n1[3] || 0) + (n1[4] || 0), i2 = (n2[3] || 0) + (n2[4] || 0);
    const dt = t2 - t1, di = i2 - i1;
    const cpu = dt > 0 ? Math.max(0, Math.min(100, ((dt - di) / dt) * 100)) : 0;
    const mem = g(/MEM:(.+)/);
    // /proc/meminfo dạng "MemTotal:  2035908 kB" — có dấu ':' nên dùng \D+ (không phải \s+)
    const mt = Number((mem.match(/MemTotal\D+(\d+)/) || [])[1] || 0);
    const ma = Number((mem.match(/MemAvailable\D+(\d+)/) || [])[1] || 0);
    const memUsed = mt - ma;
    const disk = g(/DISK:(.+)/).trim().split(/\s+/); // size used pct
    return {
      cpu: Math.round(cpu),
      cores: Number(g(/CORES:(\d+)/) || 0),
      mem_used_mb: Math.round(memUsed / 1024),
      mem_total_mb: Math.round(mt / 1024),
      mem_pct: mt > 0 ? Math.round((memUsed / mt) * 100) : 0,
      disk_pct: Number(String(disk[2] || '0').replace('%', '')),
      disk_used_gb: Math.round((Number(disk[1] || 0) / 1048576) * 10) / 10,
      disk_total_gb: Math.round((Number(disk[0] || 0) / 1048576) * 10) / 10,
    };
  } catch (e) { return { error: 'parse: ' + e.message }; }
}

function sshStats({ ip, port, username, password }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let out = '', done = false;
    const finish = (r) => { if (done) return; done = true; try { conn.end(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ error: 'timeout' }), 14000);
    const cmd = "echo S1:$(head -1 /proc/stat); sleep 0.5; echo S2:$(head -1 /proc/stat); "
      + "echo MEM:$(awk '/MemTotal|MemAvailable/{print $1,$2}' /proc/meminfo | tr '\\n' ' '); "
      + "echo CORES:$(nproc); echo DISK:$(df -P / | awk 'NR==2{print $2,$3,$5}')";
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return finish({ error: err.message }); }
        stream.on('data', (d) => { out += d.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(timer); finish(parseStats(out)); });
      });
    });
    conn.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
    conn.connect({ host: ip, port: Number(port) || 22, username: username || 'root', password, readyTimeout: 15000 });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'POST' && req.url === '/stats') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const job = JSON.parse(body);
        if (job.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
        if (!job.ip || !job.password) { res.writeHead(400); return res.end('thiếu ip/password'); }
        const st = await sshStats(job);
        res.writeHead(st.error ? 502 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(st));
      } catch (e) { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/rotate-ssh') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const job = JSON.parse(body);
        if (job.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
        if (!job.ip || !job.password || !job.new_password) {
          res.writeHead(400); return res.end('thiếu ip/password/new_password');
        }
        const r = await rotateSshPassword(job);
        res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        // KHÔNG log mật khẩu — chỉ ip và kết quả.
        console.log(`[rotate-ssh] ${job.ip} -> ${r.ok ? 'ok' : 'FAIL: ' + r.error}`);
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400); res.end('bad json'); }
    });
    return;
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
