// Tries the attacks from the security review against a local main site (:3130) and P2P host (:3131):
// file writes through map ids, login cookies leaking to other players, planted cookies, requests
// from other sites, password guessing, oversized uploads, and P2P host takeovers.
//   node tools/security-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { io } = require('socket.io-client');

const root = path.join(__dirname, '..');
const HUB = 'http://127.0.0.1:3130', HOST = 'http://127.0.0.1:3131';
const procs = [];
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 20000) => new Promise((ok, fail) => {
  const t0 = Date.now();
  (function poll() { const v = fn(); if (v) return ok(v); if (Date.now() - t0 > ms) return fail(new Error('timed out')); setTimeout(poll, 100); })();
});
const run = (args, env) => { const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };
const form = { 'content-type': 'application/x-www-form-urlencoded' };
function jar(base) {
  const j = { cookie: '' };
  j.get = async (p, o = {}) => {
    const r = await fetch(base + p, { redirect: 'manual', ...o, headers: { cookie: j.cookie, ...(o.headers || {}) } });
    for (const c of r.headers.getSetCookie()) j.cookie = c.split(';')[0];
    j.lastSetCookie = r.headers.getSetCookie().join('\n');
    return r;
  };
  j.sock = (nsp, headers = {}) => io(base + nsp, { transports: ['websocket'], extraHeaders: { cookie: j.cookie, ...headers }, reconnection: false, forceNew: true });
  return j;
}
const tpid = (j) => j.cookie.replace(/^tpid=/, '');
// a valid PNG header claiming a huge image (the pixel data is tiny: it would decode to gigabytes)
function hugePng(w, h) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1000))), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  run(['server/index.js'], { PORT: '3130', HOST: '127.0.0.1' });
  const a = jar(HUB);
  for (let i = 0; ; i++) { try { await a.get('/'); break; } catch (e) { if (i > 100) throw e; await wait(200); } }

  // ---- cookies ----
  check(/HttpOnly/.test(a.lastSetCookie), 'login cookie is HttpOnly (page scripts can\'t read it)');
  const planted = jar(HUB); planted.cookie = 'tpid=AttackerChoseThisCookie1234';
  await planted.get('/');
  check(tpid(planted) !== 'AttackerChoseThisCookie1234', 'a cookie value this server never issued is replaced');
  const user = 'sec' + Date.now().toString(36).slice(-8);
  const before = tpid(a);
  await a.get('/register', { method: 'POST', headers: form, body: `username=${user}&password=hunter22` });
  check(tpid(a) !== before && a.cookie, 'signing up issues a new cookie');
  const b4login = tpid(a);
  await a.get('/logout');
  await a.get('/login', { method: 'POST', headers: form, body: `username=${user}&password=hunter22` });
  const prof = await a.get('/profile');
  check(tpid(a) !== b4login && prof.status === 200, 'logging in issues a new cookie and works');

  // ---- pages: no third-party tracker; nobody else's name in your header ----
  check(!/redditstatic|rdt\(/.test(await (await a.get('/')).text()), 'pages no longer load the Reddit ad tracker');
  const guest = jar(HUB); await guest.get('/');
  // wrong passwords for a real account, so each log in really waits on the password check
  const other = jar(HUB); await other.get('/');
  const user2 = 'r' + user;
  await other.get('/register', { method: 'POST', headers: { ...form, 'x-forwarded-for': '10.9.8.1' }, body: `username=${user2}&password=hunter22` });
  const guestPages = Array.from({ length: 8 }, (_, i) => guest.get('/login', { method: 'POST', headers: { ...form, 'x-forwarded-for': '10.9.9.' + i }, body: `username=${user2}&password=wrong${i}` }).then((r) => r.text()));
  for (let i = 0; i < 40; i++) { a.get('/groups'); await wait(5); } // the logged-in player keeps loading pages meanwhile
  const pagesSeen = (await Promise.all(guestPages)).map((t) => ({ guest: true, t }));
  check(pagesSeen.filter((x) => x.guest).every((x) => !x.t.includes('>' + user + '<')), 'a guest\'s page never shows another player\'s name (requests at the same time)');

  // ---- requests from other sites ----
  const evil = await a.get('/profile', { method: 'POST', headers: { ...form, origin: 'https://1-2-3-4.sslip.io' }, body: 'displayedName=pwned' });
  check(evil.status === 403, 'a form posted from another sslip.io site is refused');
  const evil2 = await a.get('/groups/create', { method: 'POST', headers: { ...form, 'sec-fetch-site': 'same-site' }, body: 'name=x' });
  check(evil2.status === 403, 'a same-site (other subdomain) post is refused');
  const sock = a.sock('/groups/abcdefgh', { origin: 'https://1-2-3-4.sslip.io' });
  const refused = await new Promise((ok) => { sock.on('connect', () => ok(false)); sock.on('connect_error', () => ok(true)); setTimeout(() => ok(true), 3000); });
  check(refused, 'a socket connection from another site is refused');
  sock.close();
  const out = await a.get('/logout', { headers: { 'sec-fetch-site': 'cross-site' } });
  check(out.status === 302 && (await a.get('/profile')).status === 200, 'a log out link on another site does nothing');

  // ---- password guessing ----
  let blocked = false;
  const g2 = jar(HUB); await g2.get('/');
  for (let i = 0; i < 12; i++) {
    const t = await (await g2.get('/login', { method: 'POST', headers: form, body: `username=${user}&password=wrong${i}` })).text();
    if (/Too many tries/.test(t)) { blocked = i >= 10; break; }
  }
  check(blocked, 'after 10 wrong passwords, log ins are paused');

  // ---- group: ids, map file writes, uploads ----
  const gid = (await a.get('/groups/create', { method: 'POST', headers: form, body: 'name=Sec&private=on' })).headers.get('location').split('/').pop();
  const lead = a.sock('/groups/' + gid);
  const members = {}, chat = [];
  let you = null;
  lead.on('member', (m) => { members[m.id] = m; });
  lead.on('you', (id) => { you = id; });
  lead.on('chat', (c) => chat.push(c.message));
  await new Promise((ok) => lead.on('loaded', ok));
  check(you && you !== tpid(a) && !Object.keys(members).includes(tpid(a)), 'group member ids are not the login cookie');

  const proof = path.join(root, 'tools', 'TRAVERSAL-PROOF');
  lead.emit('setting', { name: 'map', value: 'fm_id/abc#/../../tools/TRAVERSAL-PROOF' });
  lead.emit('setting', { name: 'time', value: '1' });
  await wait(200);
  lead.emit('groupPlay');
  await new Promise((ok) => lead.on('play', ok));
  check(!fs.existsSync(proof + '.json') && !fs.existsSync(proof + '.png'), 'a crafted map id writes no files outside maps/');
  for (const e of ['.json', '.png']) try { fs.unlinkSync(proof + e); } catch (e2) { /* not there: good */ }

  const j = a.sock('/games/find');
  j.on('ready', () => j.emit('JoinerSelections', { regions: [], gameModes: ['classic'] }));
  await new Promise((ok) => j.on('FoundWorld', ok));
  const page = await (await a.get('/game')).text();
  const gs = a.sock(page.match(/gameSocket = location.origin \+ "([^"]+)"/)[1]);
  const raw = [];
  gs.onAny((ev, d) => raw.push(JSON.stringify(d)));
  await wait(1500);
  check(raw.length > 0 && !raw.some((x) => x.includes(tpid(a))), 'game packets never contain the login cookie');
  for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) gs.emit('keydown', { k, t: 7 });
  await wait(800);
  check(!raw.some((x) => /"(toString|constructor|hasOwnProperty)":/.test(x)), 'key names like toString are ignored, not sent to other players');
  gs.close(); j.close();

  const fd = new FormData();
  fd.append('layout', new Blob([hugePng(20000, 20000)]), 'map.png');
  fd.append('logic', new Blob(['{}']), 'map.json');
  const up = await (await a.get('/groups/testmap', { method: 'POST', body: fd })).json();
  check(!up.success && /20000 x 20000/.test(up.error), 'a map image that would decode to gigabytes is refused before decoding');
  const many = new FormData();
  for (let i = 0; i < 6; i++) many.append('layout', new Blob([Buffer.alloc(1000)]), 'x.png');
  const manyRes = await a.get('/groups/testmap', { method: 'POST', body: many });
  check(manyRes.status >= 400, 'an upload with extra files is refused');

  const settingsSeen = {};
  lead.on('setting', (x) => { settingsSeen[x.name] = x.value; });
  lead.emit('setting', { name: 'toString', value: 'x' });
  lead.emit('setting', { name: 'map', value: 'y'.repeat(500000) });
  lead.emit('touch', 'z'.repeat(500000));
  await wait(500);
  check(!Object.hasOwn(settingsSeen, 'toString') && String(settingsSeen.map).length <= 300, 'built-in setting names are ignored and huge setting values are cut short (map: ' + String(settingsSeen.map).length + ' chars, toString: ' + settingsSeen.toString + ')');
  check(Object.values(members).every((m) => String(m.location).length <= 64), 'a huge location message is cut short');
  const ms = require('../server/mapstats');
  ms.rate({ id: 'x', account: null }, '__proto__', 1);
  check(({}).hasOwnProperty('s:x') === false && ({})['s:x'] === undefined, 'rating a map named __proto__ doesn\'t change built-in objects');

  let flood = 0;
  const seen = chat.length;
  for (let i = 0; i < 30; i++) lead.emit('chat', 'spam ' + i);
  await wait(500);
  flood = chat.slice(seen).filter((m) => /^spam/.test(m)).length;
  check(flood === 20, `chat spam is cut off at 20 per 5 seconds (${flood} of 30 got through)`);

  // ---- Play Now: one address can't fill the queue ----
  const qs = [];
  for (let i = 0; i < 5; i++) {
    const p = jar(HUB); await p.get('/');
    const sk = p.sock('/games/find');
    qs.push(new Promise((ok) => { sk.on('ready', () => sk.emit('JoinerSelections', {})); sk.on('SendToPage', (d) => ok(d.reason)); setTimeout(() => ok(null), 2500); }).then((r) => { sk.close(); return r; }));
    await wait(150);
  }
  const reasons = await Promise.all(qs);
  check(reasons.filter((r) => /Too many players from your network/.test(r || '')).length === 1, 'the 5th queue entry from one address is turned away');

  // ---- peer to peer ----
  let status = null;
  lead.on('p2p', (s) => { status = s; });
  lead.emit('setting', { name: 'server', value: 'p2p' });
  await until(() => status && status.on && status.code);
  const hostSock = (code, url) => new Promise((ok) => {
    const h = io(HUB + '/p2p-host', { auth: { code, url, name: 'x' }, transports: ['websocket'], reconnection: false, forceNew: true });
    h.on('rejected', (why) => { h.close(); ok(why); });
    h.on('accepted', () => { h.close(); ok('accepted'); });
  });
  check(/https/.test(await hostSock(status.code, 'http://127.0.0.1:3131')), 'a host with a plain http:// address is refused');
  check(/private or local/.test(await hostSock(status.code, 'https://localhost:3131')), 'a host address on a private or local network is refused');

  // leadership passes to Bob: the old code stops working
  const bob = jar(HUB); await bob.get('/');
  await bob.get('/groups/' + gid + '/p2p', { method: 'POST', headers: form, body: 'choice=watch' });
  const bs = bob.sock('/groups/' + gid);
  let bobId = null; bs.on('you', (id) => { bobId = id; });
  await new Promise((ok) => bs.on('loaded', ok));
  const oldCode = status.code;
  lead.emit('leader', bobId);
  await until(() => status.code === null);
  check(/Unknown host code/.test(await hostSock(oldCode, 'https://example.com')), 'a former leader\'s host code no longer works');

  // a host's PC: no log ins, groups or queue of its own
  run(['server/index.js'], { PORT: '3131', HOST: '127.0.0.1', P2P_CODE: 'unused', P2P_HUB: HUB, P2P_URL: HOST });
  for (let i = 0; ; i++) { try { await fetch(HOST + '/p2p/ping'); break; } catch (e) { if (i > 100) throw e; await wait(200); } }
  const hostPost = await fetch(HOST + '/register', { method: 'POST', headers: form, body: 'username=x&password=yyyyyy' });
  check(hostPost.status === 403, 'a P2P host accepts no form posts (log ins, groups, uploads)');
  const hj = jar(HOST); await hj.get('/game');
  const q = hj.sock('/games/find');
  const qOk = await new Promise((ok) => { q.on('ready', () => ok(true)); q.on('connect_error', () => ok(false)); setTimeout(() => ok(false), 3000); });
  check(!qOk, 'a P2P host runs no Play Now queue');
  q.close();

  lead.close(); bs.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  for (const p of procs) p.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); for (const p of procs) p.kill(); process.exit(1); });
