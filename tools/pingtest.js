// Measures game-socket ping (p -> pr) against a running local game, like the real client does.
const { io } = require('socket.io-client');
const base = process.argv[2] || 'http://localhost:3000';
let cookie = '';
const get = async (p, o = {}) => { const r = await fetch(base + p, { redirect: 'manual', ...o, headers: { cookie, ...(o.headers || {}) } }); for (const c of r.headers.getSetCookie?.() || []) cookie = c.split(';')[0]; return r; };
(async () => {
  await get('/');
  await get('/games/find');
  const j = io(base + '/games/find', { transports: ['websocket'], extraHeaders: { cookie } });
  j.on('ready', () => j.emit('JoinerSelections', {}));
  await new Promise((r) => j.on('FoundWorld', r)); j.disconnect();
  const sock = (await (await get('/game')).text()).match(/gameSocket = location.origin \+ "([^"]+)"/)[1];
  const s = io(base + sock, { transports: ['websocket'], extraHeaders: { cookie } });
  const sent = {}; const rtts = [];
  s.on('pr', (id) => rtts.push(Date.now() - sent[id]));
  let n = 0; const t = setInterval(() => { sent[n] = Date.now(); s.emit('p', { id: n++ }); }, 200);
  let last = Date.now(), maxGap = 0, packets = 0;
  s.onAny(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; packets++; });
  setTimeout(() => { clearInterval(t); rtts.sort((a, b) => a - b); console.log('rtt ms: median', rtts[rtts.length >> 1], 'max', rtts[rtts.length - 1], '| packets', packets, 'max gap', maxGap, 'ms'); process.exit(0); }, 8000);
})();
