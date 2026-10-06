// bots.js - simple TagPro bots that join a local group like real players (group socket ->
// joiner -> game socket) and play CTF: grab, run home, chase enemy flag carriers, defend.
//   node tools/bots.js <groupId> [count] [baseUrl]
//   node tools/bots.js queue [count] [baseUrl]     (bots use Play Now / the public queue)
const { io } = require('socket.io-client');
const { BotBrain } = require('../server/botBrain');

const [groupId, countArg, baseArg] = process.argv.slice(2);
if (!groupId) { console.error('usage: node tools/bots.js <groupId> [count] [baseUrl]'); process.exit(1); }
const COUNT = Number(countArg || 3);
const BASE = baseArg || 'http://localhost:3000';

class Bot extends BotBrain {
  constructor(i) {
    super(i, (ev, d) => this.game && this.game.emit(ev, d));
    this.name = 'Bot ' + (i + 1);
    this.cookie = '';
  }

  log(...a) { console.log(`[${this.name}]`, ...a); }

  async http(path, opts = {}) {
    const r = await fetch(BASE + path, { redirect: 'manual', ...opts, headers: { cookie: this.cookie, ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) this.cookie = c.split(';')[0];
    return r;
  }

  sock(path, query) {
    return io(BASE + path, { transports: ['websocket'], extraHeaders: { cookie: this.cookie }, query, reconnection: false });
  }

  async start() {
    await this.http('/');
    await this.http('/local/name', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=' + encodeURIComponent(this.name) });
    if (groupId === 'queue') { this.queueMode = true; return this.findGame(); }
    await this.http('/groups/' + groupId);
    this.joinGroup();
  }

  joinGroup() {
    const g = this.group = this.sock('/groups/' + groupId, { group: groupId });
    const members = {};
    let me = null, settings = {};
    g.on('member', (m) => {
      members[m.id] = m;
      // hand leadership to a human if a bot ended up leading
      if (me && members[me] && members[me].leader && !m.name.startsWith('Bot ') && m.id !== me) g.emit('leader', m.id);
    });
    g.on('removed', (m) => delete members[m.id]);
    g.on('setting', (s) => { settings[s.name] = s.value; });
    g.on('you', (id) => { me = id; });
    g.on('loaded', () => {
      g.emit('touch', 'page');
      if (settings.isPrivate) {
        const red = Object.values(members).filter((m) => m.team === 1).length;
        const blue = Object.values(members).filter((m) => m.team === 2).length;
        const team = red <= blue ? 1 : 2;
        setTimeout(() => g.emit('team', { id: me, team }), 200 + this.i * 150);
      }
      this.log('joined group', groupId);
    });
    g.on('play', () => this.findGame());
    g.on('groupKick', () => { this.log('kicked'); process.exit(0); });
    g.on('disconnect', () => this.log('group socket closed'));
    this.touch = setInterval(() => g.connected && g.emit('touch', this.location || 'page'), 5000);
  }

  async findGame() {
    if (this.game) return;
    this.location = 'joiner';
    await this.http('/games/find');
    const j = this.sock('/games/find', {});
    j.on('ready', () => j.emit('JoinerSelections', { regions: [], gameModes: ['classic'] }));
    j.on('FoundWorld', async () => {
      j.disconnect();
      const html = await (await this.http('/game')).text();
      const m = html.match(/gameSocket = location.origin \+ "([^"]+)"/);
      if (!m) { this.location = 'page'; return; }
      this.playGame(m[1]);
    });
    j.on('SendToPage', () => { j.disconnect(); this.location = 'page'; });
    j.on('Full', () => { if (!this.saidQueued) { this.saidQueued = true; this.log('in queue'); } });
  }

  playGame(path) {
    this.location = 'game';
    const s = this.game = this.sock(path, {});
    this.reset();
    s.onAny((ev, d) => this.receive(ev, d));
    s.on('end', () => setTimeout(() => this.leaveGame(), 3000));
    s.on('disconnect', () => this.leaveGame());
    this.brain = setInterval(() => this.think(), 50);
  }

  leaveGame() {
    if (!this.game) return;
    clearInterval(this.brain);
    this.game.removeAllListeners(); this.game.disconnect(); this.game = null;
    this.location = 'page';
    if (this.group) this.group.emit('touch', 'page');
    if (this.queueMode) setTimeout(() => this.findGame(), 3000); // requeue after each game
  }
}

(async () => {
  for (let i = 0; i < COUNT; i++) {
    const b = new Bot(i);
    await b.start();
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`${COUNT} bots in group ${groupId}. Ctrl+C to remove them.`);
})();
