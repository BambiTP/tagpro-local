// Follows a real TagPro group launch as a guest: group -> joiner -> game, logging every
// packet (read-only besides the handshake the real client does) and saving the live game page.
const { io } = require('socket.io-client');
const fs = require('fs');
const id = process.argv[2], gameSecs = +(process.argv[3] || 90);
const base = 'https://tagpro.koalabeast.com';
const outDir = __dirname + '/../ref/live';
fs.mkdirSync(outDir, { recursive: true });
let cookies = {};
const take = (res) => (res.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); });
const hdr = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const get = async (url) => { const r = await fetch(url, { headers: { cookie: hdr() }, redirect: 'follow' }); take(r); return r.text(); };
const t0 = Date.now(), logs = {};
function tap(name, s) {
  logs[name] = [];
  s.onAny((ev, ...a) => { logs[name].push([Date.now() - t0, ev, ...a]); if (ev !== 'p' && ev !== 'member') console.log(name, Date.now() - t0, ev, JSON.stringify(a).slice(0, 200)); });
  s.on('connect_error', e => console.error(name, 'connect_error', e.message));
}
function save() { for (const [k, v] of Object.entries(logs)) fs.writeFileSync(`${outDir}/${k}.ndjson`, v.map(x => JSON.stringify(x)).join('\n')); console.error('saved', Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.length]))); }
const opts = (extra) => ({ transports: ['websocket'], extraHeaders: { cookie: hdr(), origin: base }, ...extra });
(async () => {
  await get(base + '/'); await get(base + '/groups/' + id);
  const g = io(base + '/groups/' + id, opts({ query: { group: id } })); tap('group', g);
  g.on('connect', () => g.emit('touch', 'page'));
  setInterval(() => g.connected && g.emit('touch', g.loc || 'page'), 5000);
  let gameNo = 0, gs = null;
  const backToGroup = (why) => {
    if (!gs) return;
    console.error('game over (' + why + ') -> back to group page');
    const n = 'game' + gameNo; logs[n] = logs.game; delete logs.game; save();
    gs.removeAllListeners(); gs.disconnect(); gs = null;
    g.loc = 'page'; g.emit('touch', 'page');
  };
  g.on('play', async () => {
    if (gs) return;
    console.error('PLAY -> joiner');
    g.loc = 'joiner'; g.emit('touch', 'joiner');
    fs.writeFileSync(`${outDir}/find.html`, await get(base + '/games/find'));
    const j = io(base + '/games/find', opts({ query: { joinerfrom: '/groups/' + id }, auth: { page: '/games/find' } })); tap('joiner' + (gameNo + 1), j);
    j.on('ready', () => j.emit('JoinerSelections', { regions: ['US East', 'US Central', 'US West', 'Europe', 'Oceanic'], gameModes: ['classic'] }));
    j.on('SendToPage', () => { j.disconnect(); g.loc = 'page'; g.emit('touch', 'page'); });
    j.on('FoundWorld', async (e) => {
      j.disconnect();
      const url = new URL(e.url, base).href; console.error('FoundWorld', JSON.stringify(e));
      const html = await get(url); fs.writeFileSync(`${outDir}/game${gameNo + 1}.html`, html);
      const m = html.match(/tagproConfig\.gameSocket\s*=\s*["']([^"']*)["']/);
      let sock = m && m[1] ? m[1] : url; if (!/^[a-z]+:\/\//i.test(sock)) sock = 'https://' + sock;
      console.error('gameSocket', sock);
      gameNo++; g.loc = 'game'; g.emit('touch', 'game');
      gs = io(sock, opts({ query: { game: m && m[1] }, reconnection: false })); tap('game', gs);
      let seq = 0, wig = null;
      gs.on('arrivedInGame', (a) => {
        if (a && a.spectateType) return;
        // anti-AFK: tap a direction briefly every ~8s, like a mostly idle real player
        wig = setInterval(() => {
          if (!gs) return clearInterval(wig);
          const k = ['left', 'right', 'up', 'down'][Math.floor(Math.random() * 4)];
          gs.emit('keydown', { k, t: seq++ }); setTimeout(() => gs && gs.emit('keyup', { k, t: seq++ }), 150);
        }, 8000);
      });
      gs.on('disconnectReason', r => setTimeout(() => backToGroup('reason ' + r), 500));
      gs.on('end', () => setTimeout(() => backToGroup('end'), 10000));
      gs.on('disconnect', r => backToGroup('disconnect ' + r));
    });
  });
  process.on('SIGINT', () => { save(); process.exit(0); });
  setTimeout(() => { console.error('session timeout'); backToGroup('timeout'); save(); process.exit(0); }, 60 * 60 * 1000);
})();
