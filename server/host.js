// host.js - host a peer-to-peer group's games on this PC:
//   npm run host -- <code from the group page> [--name "Your name"] [--port 3000]
// Starts this server, gives it a public https address with a free Cloudflare quick tunnel (no
// account or router setup; cloudflared is downloaded into bin/ the first time), and connects to
// the main site so the group's games are created here. Already have a public address (an open
// port, your own tunnel)? Pass it with --url http://your.address:3000 to skip the tunnel.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_HUB = 'https://152-44-39-10.sslip.io';

function args() {
  const a = process.argv.slice(2), o = { code: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
    else if (!o.code) o.code = a[i];
  }
  return o;
}

const BIN = path.join(__dirname, '..', 'bin');
const ASSETS = {
  'linux-x64': 'cloudflared-linux-amd64', 'linux-arm64': 'cloudflared-linux-arm64', 'linux-arm': 'cloudflared-linux-arm',
  'win32-x64': 'cloudflared-windows-amd64.exe', 'win32-ia32': 'cloudflared-windows-386.exe', 'win32-arm64': 'cloudflared-windows-amd64.exe',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz', 'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
};

async function cloudflared() {
  const exe = path.join(BIN, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(exe)) return exe;
  try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore' }); return 'cloudflared'; } catch (e) { /* not installed */ }
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`no cloudflared download for ${process.platform}-${process.arch}; install it yourself or pass --url`);
  console.log('Downloading cloudflared (Cloudflare\'s tunnel program, one time only) ...');
  const r = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset);
  if (!r.ok) throw new Error('cloudflared download failed: HTTP ' + r.status);
  fs.mkdirSync(BIN, { recursive: true });
  const file = path.join(BIN, asset);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  if (asset.endsWith('.tgz')) { execFileSync('tar', ['-xzf', file, '-C', BIN]); fs.unlinkSync(file); } else fs.renameSync(file, exe);
  fs.chmodSync(exe, 0o755);
  return exe;
}

// a quick tunnel prints its https://<words>.trycloudflare.com address once it is up
function tunnel(exe, port) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(() => reject(new Error('the tunnel did not start within 60 seconds:\n' + log.slice(-2000))), 60000);
    const read = (b) => {
      log += b;
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout.on('data', read); p.stderr.on('data', read);
    p.on('exit', (c) => { clearTimeout(timer); reject(new Error('cloudflared exited (' + c + '):\n' + log.slice(-2000))); });
    process.on('exit', () => p.kill());
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  });
}

(async () => {
  const o = args();
  if (!o.code) {
    console.log('Usage: npm run host -- <code> [--name "Your name"] [--port 3000] [--url <public address>]\nThe code is in the Peer to Peer box on your group\'s page.');
    process.exit(1);
  }
  const port = Number(o.port || process.env.PORT || 3000);
  let url = o.url;
  if (!url) {
    console.log('Opening a public address for this PC ...');
    url = await tunnel(await cloudflared(), port);
    process.env.HOST = '127.0.0.1'; // only reachable through the tunnel
  }
  Object.assign(process.env, {
    PORT: String(port), P2P_HUB: (o.hub || process.env.P2P_HUB || DEFAULT_HUB).replace(/\/+$/, ''),
    P2P_CODE: o.code, P2P_URL: url.replace(/\/+$/, ''), P2P_NAME: o.name || process.env.P2P_NAME || '', // empty: the main site uses the group leader's name
  });
  console.log('Public address: ' + url);
  require('./index');
})().catch((e) => { console.error('Could not start hosting: ' + e.message); process.exit(1); });
