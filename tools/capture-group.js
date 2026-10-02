// Joins a real TagPro group as a guest and logs every server event (read-only).
const { io } = require('socket.io-client');
const fs = require('fs');
const id = process.argv[2], secs = +(process.argv[3] || 25);
const base = 'https://tagpro.koalabeast.com';
(async () => {
  let cookies = {};
  const take = (res) => (res.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); });
  const hdr = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  for (const p of ['/', '/groups/' + id]) take(await fetch(base + p, { headers: { cookie: hdr() }, redirect: 'manual' }));
  console.error('cookies:', Object.keys(cookies));
  const out = [], t0 = Date.now();
  const s = io(base + '/groups/' + id, { transports: ['websocket'], query: { group: id }, extraHeaders: { cookie: hdr(), origin: base } });
  s.onAny((ev, ...a) => { out.push([Date.now() - t0, ev, ...a]); console.log(Date.now() - t0, ev, JSON.stringify(a).slice(0, 300)); });
  s.on('connect', () => { console.error('connected'); s.emit('touch', 'page'); });
  s.on('connect_error', e => console.error('connect_error', e.message));
  setTimeout(() => { s.disconnect(); fs.writeFileSync(`../ref/group-capture-${id}.ndjson`, out.map(x => JSON.stringify(x)).join('\n')); console.error('saved', out.length); process.exit(0); }, secs * 1000);
})();
