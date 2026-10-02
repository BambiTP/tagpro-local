// bots.js - simple TagPro bots that join a local group like real players (group socket ->
// joiner -> game socket) and play CTF: grab, run home, chase enemy flag carriers, defend.
//   node tools/bots.js <groupId> [count] [baseUrl]
//   node tools/bots.js queue [count] [baseUrl]     (bots use Play Now / the public queue)
const { io } = require('socket.io-client');

const [groupId, countArg, baseArg] = process.argv.slice(2);
if (!groupId) { console.error('usage: node tools/bots.js <groupId> [count] [baseUrl]'); process.exit(1); }
const COUNT = Number(countArg || 3);
const BASE = baseArg || 'http://localhost:3000';
const TILE = 0.4;

class Bot {
  constructor(i) {
    this.i = i;
    this.name = 'Bot ' + (i + 1);
    this.role = i % 2 === 0 ? 'offense' : 'defense';
    this.cookie = '';
    this.seq = 1;
    this.keys = { up: false, down: false, left: false, right: false };
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
    this.players = {}; this.map = null; this.id = null; this.state = 3;
    s.on('map', (m) => { this.map = m.tiles; this.findBases(); });
    s.on('mapupdate', (u) => { for (const t of Array.isArray(u) ? u : [u]) if (this.map) this.map[t.x][t.y] = t.v; });
    s.on('id', (id) => { this.id = id; });
    s.on('time', (t) => { this.state = t.state; });
    s.on('p', (d) => {
      for (const u of d.u || d) {
        const p = this.players[u.id] || (this.players[u.id] = {});
        Object.assign(p, u);
        if ('rx' in u || 'ry' in u || 'lx' in u) p.at = Date.now();
      }
    });
    s.on('playerLeft', (id) => delete this.players[id]);
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

  findBases() {
    this.home = {};
    for (let x = 0; x < this.map.length; x++) for (let y = 0; y < this.map[0].length; y++) {
      const t = parseFloat(this.map[x][y]);
      if (Math.floor(t) === 3) this.home[1] = { x, y };
      if (Math.floor(t) === 4) this.home[2] = { x, y };
    }
  }

  // passable for path finding: floor-like tiles, avoiding spikes/walls/void and hostile gates
  passable(x, y, team) {
    if (x < 0 || y < 0 || x >= this.map.length || y >= this.map[0].length) return false;
    const t = parseFloat(this.map[x][y]);
    if (t === 0 || Math.floor(t) === 1 || t === 7) return false;
    if (t === 9.1 || (t === 9.2 && team === 2) || (t === 9.3 && team === 1)) return false;
    return true;
  }

  // BFS over tiles; returns next waypoint (tile) a few steps along the path
  nextWaypoint(from, to, team) {
    const W = this.map.length, H = this.map[0].length, key = (x, y) => x * H + y;
    const prev = new Map([[key(from.x, from.y), null]]);
    const q = [from];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let found = null;
    while (q.length && prev.size < 6000) {
      const c = q.shift();
      if (c.x === to.x && c.y === to.y) { found = c; break; }
      for (const [dx, dy] of dirs) {
        const nx = c.x + dx, ny = c.y + dy;
        if (prev.has(key(nx, ny)) || !this.passable(nx, ny, team)) continue;
        if (dx && dy && (!this.passable(c.x + dx, c.y, team) || !this.passable(c.x, c.y + dy, team))) continue; // no corner cutting
        prev.set(key(nx, ny), c);
        q.push({ x: nx, y: ny });
      }
    }
    if (!found) return to;
    const path = [];
    for (let c = found; c; c = prev.get(key(c.x, c.y))) path.unshift(c);
    return path[Math.min(2, path.length - 1)];
  }

  setKey(k, down) {
    if (this.keys[k] === down) return;
    this.keys[k] = down;
    this.game.emit(down ? 'keydown' : 'keyup', { k, t: this.seq++ });
  }

  think() {
    const me = this.players[this.id];
    if (!this.game || !this.map || !me || me.dead || me.rx == null || ![1, 5, 7].includes(this.state)) {
      for (const k in this.keys) this.setKey(k, false);
      return;
    }
    // extrapolate our position since the last server update
    const dt = Math.min(0.3, (Date.now() - (me.at || Date.now())) / 1000);
    const px = me.rx + (me.lx || 0) * dt, py = me.ry + (me.ly || 0) * dt;
    const myTile = { x: Math.round(px / TILE), y: Math.round(py / TILE) };
    const enemy = me.team === 1 ? 2 : 1;
    const enemies = Object.values(this.players).filter((p) => p.team === enemy && !p.dead && p.rx != null);
    const enemyFC = enemies.find((p) => p.flag);
    let goal;
    if (me.flag) goal = this.home[me.team];
    else if (enemyFC) goal = { x: Math.round(enemyFC.rx / TILE), y: Math.round(enemyFC.ry / TILE) };
    else if (this.role === 'defense') {
      const h = this.home[me.team];
      const near = enemies.filter((p) => Math.hypot(p.rx / TILE - h.x, p.ry / TILE - h.y) < 8)[0];
      goal = near ? { x: Math.round(near.rx / TILE), y: Math.round(near.ry / TILE) } : { x: h.x + (this.i % 3) - 1, y: h.y + 2 };
    } else goal = this.home[enemy];
    if (!goal) return;
    if (!this.passable(goal.x, goal.y, me.team)) goal = this.home[me.team] || goal;
    const wp = this.nextWaypoint(myTile, goal, me.team);
    // steer: desired velocity toward the waypoint, press keys to close the velocity gap
    const tx = wp.x * TILE, ty = wp.y * TILE;
    const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy) || 1;
    const want = 2.5, dvx = dx / d * want - (me.lx || 0), dvy = dy / d * want - (me.ly || 0);
    this.setKey('right', dvx > 0.25); this.setKey('left', dvx < -0.25);
    this.setKey('down', dvy > 0.25); this.setKey('up', dvy < -0.25);
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
