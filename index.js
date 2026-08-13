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

// Đoạn cài cloudflared tunnel (khi có token) — chạy như systemd service
function tunnelSnippet(token) {
  if (!token) return [];
  return [
    '# --- Cloudflare Tunnel ---',
    'if ! command -v cloudflared >/dev/null 2>&1; then',
    '  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared',
    '  $SUDO install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared',
    'fi',
    '$SUDO cloudflared service uninstall >/dev/null 2>&1 || true',
    `$SUDO cloudflared service install ${token}`,
    '$SUDO systemctl restart cloudflared || true',
    'echo "===TUNNEL_DONE==="',
  ];
}

// Lệnh cài: script chính thức 1 dòng, LUÔN chạy non-interactive (bỏ mọi bước
// hỏi bàn phím như "Choose language") — nếu không sẽ treo tới timeout.
function buildInstallCommand(lang, tunnelToken) {
  const l = lang === 'en' ? 'en' : 'vi';
  // Nhiều máy cloud không cho root SSH → dùng ubuntu + sudo. $SUDO tự rỗng khi là root.
  const SUDO = 'SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo "sudo")';
  return [
    'set -x',
    'export DEBIAN_FRONTEND=noninteractive',
    'export TUBECLI_NONINTERACTIVE=1',
    SUDO,
    // Chờ apt lock (máy mới hay bận cloud-init)
    'for i in $(seq 1 30); do $SUDO fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; echo "cho apt lock..."; sleep 5; done',
    '$SUDO apt-get update -y || true',
    '$SUDO apt-get install -y curl || true',
    // Cài TubeCLI — non-interactive + ngôn ngữ cố định
    `curl -fsSL https://raw.githubusercontent.com/tubecreate/tubecli/main/install.sh | bash -s -- --non-interactive --lang ${l}`,
    // Mở firewall nếu có ufw
    `command -v ufw >/dev/null 2>&1 && $SUDO ufw allow ${TUBECLI_PORT}/tcp || true`,
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

function sshExec({ ip, port, username, password, command, timeoutMs = 15 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let output = '';
    let settled = false;
    const finish = (ok, extra = '') => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      resolve({ ok, output: output + (extra ? `\n${extra}` : '') });
    };
    const timer = setTimeout(() => finish(false, `[provisioner] Timeout sau ${timeoutMs / 60000} phút`), timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, { pty: true }, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(false, `exec error: ${err.message}`); }
        stream.on('data', (d) => { output += d.toString(); if (output.length > 200000) output = output.slice(-150000); });
        stream.stderr.on('data', (d) => { output += d.toString(); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          const done = output.includes('===INSTALL_DONE===');
          finish(done && (code === 0 || done), `[exit code: ${code}]`);
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

// Retry SSH — server mới có thể chưa mở SSH ngay
async function sshExecWithRetry(job, tries = 5) {
  let last = { ok: false, output: '' };
  for (let i = 1; i <= tries; i++) {
    last = await sshExec(job);
    if (last.ok) return last;
    if (!/ssh error|Timed out|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/i.test(last.output)) return last;
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
    : buildInstallCommand(job.lang, job.tunnel_token);
  const result = await sshExecWithRetry({ ...job, command });

  const tubecliUrl = `http://${job.ip}:${TUBECLI_PORT}`;
  // Xác minh TubeCLI đã lên (tối đa 2 phút) — bỏ qua với mode tunnel
  let alive = mode === 'tunnel';
  if (result.ok && mode !== 'tunnel') {
    for (let i = 0; i < 12; i++) {
      try {
        const res = await fetch(`${tubecliUrl}/api/v1/status`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) { alive = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Thành công = install.sh chạy trọn (===INSTALL_DONE===). Việc cổng 5295 có
  // truy cập được từ ngoài chỉ là cảnh báo — firewall được mở lúc thuê máy và
  // có thể cần vài giây để áp dụng.
  const payload = {
    secret: SECRET,
    ref: job.ref,
    mode,
    ok: result.ok,
    tubecli_url: result.ok ? tubecliUrl : '',
    log: result.output.slice(-18000) + (result.ok && !alive && mode === 'install'
      ? '\n[provisioner] Lưu ý: chưa xác nhận cổng ' + TUBECLI_PORT + ' từ bên ngoài. Nếu không mở được dashboard, kiểm tra firewall/security group của VPS đã mở TCP ' + TUBECLI_PORT + '.'
      : ''),
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
