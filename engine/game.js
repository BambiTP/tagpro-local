// game.js - an authoritative TagPro game room. Transport-agnostic and isomorphic: the Node
// server feeds it socket.io sockets, a P2P host feeds it WebRTC channels. A "client" is any
// object with emit(event, data) and disconnect(); the room calls client.onRoomEvent hooks.
//
// Packet shapes/order and timings follow captures of the real server (ref/live*, ref/replays).
// Physics mirrors the official client's prediction step exactly (same Box2D build).
(function () {
const isNode = typeof module !== 'undefined' && module.exports;
const Box2D = isNode ? require('./box2d') : globalThis.Box2D;
const C = isNode ? require('./constants') : globalThis.TPConstants;
const { PHYSICS: PH, TUNING: TU, STATES } = C;
const V = Box2D.Common.Math.b2Vec2;

const r2 = (v) => Math.round(v * 100) / 100;
const pad = (n) => (n < 10 ? '0' : '') + n;
const mmss = (ms) => { const s = Math.floor(ms / 1000); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };

// tile ids
const T = {
  EMPTY: 0, WALL: 1, FLOOR: 2, RED_FLAG: 3, BLUE_FLAG: 4, BOOST: 5, POWERUP: 6, SPIKE: 7, BUTTON: 8,
  GATE_OFF: 9, GATE_ON: 9.1, GATE_RED: 9.2, GATE_BLUE: 9.3, BOMB: 10, RED_TILE: 11, BLUE_TILE: 12,
  PORTAL: 13, RED_BOOST: 14, BLUE_BOOST: 15, YELLOW_FLAG: 16, RED_ENDZONE: 17, BLUE_ENDZONE: 18,
  GRAVITY_WELL: 22, RED_PORTAL: 24, BLUE_PORTAL: 25,
};
const PUPS = { 1: 'jukeJuice', 2: 'rollingBomb', 3: 'tagpro', 4: 'topSpeed' };

const PUBLIC_DEFAULTS = {
  time: 6, caps: 0, mercyRule: 3, overtime: true, overtimeRespawnIncrement: 3000, overtimeJukeJuice: true,
  accel: 1, topspeed: 1, bounce: 1, playerRespawnTime: 3000, speedPadRespawnTime: 10000,
  dynamiteRespawnTime: 30000, powerupRespawnTime: 60000, powerupJukeJuiceDuration: 20000,
  powerupRollingBombDuration: 20000, powerupTagproDuration: 20000, redTeamName: 'Red', blueTeamName: 'Blue',
  powerupDelay: true, ghostMode: 'disabled', poosts: true, kissingFCs: true, kissingTPs: true,
  powerupJukeJuice: true, powerupTagPro: true, powerupRollingBomb: true, powerupTopSpeed: false,
  respawnWarnings: true, pupIndicators: true, disableAllPups: false, gravityWellForce: 1, tagproMaxTags: 0,
  rollingBombForceMultipler: 1, rollingBombDistanceMultipler: 1, spacebarDetonateAll: false,
  jukeJuiceBoost: false, jukeJuiceBoostPower: 70, lastPossession: 'disabled', mapTestingMode: false,
  redTeamScore: 0, blueTeamScore: 0, maxPlayersPerTeam: 4,
};

class GameRoom {
  // opts: { id, uuid, map (from mapLoader), mapName, settings, isPrivate, groupId, onEmpty, onEnd, now }
  constructor(opts) {
    this.id = opts.id;
    this.uuid = opts.uuid || opts.id;
    this.map = opts.map;
    this.mapName = opts.mapName || (opts.map.info && opts.map.info.name) || 'Untitled';
    this.settings = Object.assign({}, PUBLIC_DEFAULTS, opts.settings || {});
    for (const k of ['powerupJukeJuiceDuration', 'powerupRollingBombDuration', 'powerupTagproDuration']) this.settings[k] = Number(this.settings[k]);
    this.isPrivate = !!opts.isPrivate;
    this.groupId = opts.groupId || null;
    this.onEmpty = opts.onEmpty || (() => {});
    this.onEnd = opts.onEnd || (() => {});
    this.now = opts.now || (() => Date.now());

    this.clients = new Set();
    this.players = {};       // id -> player
    this.nextPlayerId = 1;
    this.score = { r: Number(this.settings.redTeamScore) || 0, b: Number(this.settings.blueTeamScore) || 0 };
    this.tileGen = {}; // "x,y" -> generation; bumping it cancels pending respawn timers (map test reset)
    this.tick = 0;
    this.state = STATES.COUNTDOWN;
    this.stateEndsAt = this.now() + TU.COUNTDOWN_MS;
    this.overtimeStartedAt = null;
    this.lastClockSync = this.now();
    this.ended = false;
    this.timers = [];

    this.W = this.map.tiles.length;
    this.H = this.map.tiles[0].length;
    this.tiles = this.map.tiles.map((col) => col.slice());
    this.tileState = {};     // "x,y" -> { kind, timer handles, ... }
    this.buttonsHeld = {};   // "x,y" -> Set(playerId)
    this.gravityWells = [];
    this.spawnTiles = { 1: [], 2: [] };
    this.flagHome = { 1: null, 2: null };
    this.indexMap();
    this.buildWorld();
    this.initPowerups();
  }

  // ---------- map ----------
  indexMap() {
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const t = this.tiles[x][y];
      if (t === T.RED_FLAG) this.flagHome[1] = { x, y };
      if (t === T.BLUE_FLAG) this.flagHome[2] = { x, y };
      if (t === T.GRAVITY_WELL) this.gravityWells.push({ x: x * PH.TILE, y: y * PH.TILE });
    }
    const sp = this.map.spawnPoints || {};
    for (const [team, key] of [[1, 'red'], [2, 'blue']]) {
      const pts = sp[key] || [];
      for (const p of pts) this.spawnTiles[team].push({ x: p.x, y: p.y, radius: p.radius || 0, weight: p.weight || 1 });
      if (!this.spawnTiles[team].length && this.flagHome[team]) this.spawnTiles[team].push({ ...this.flagHome[team], radius: 2, weight: 1 });
    }
  }

  setTile(x, y, v, quiet) {
    this.tiles[x][y] = v;
    if (!quiet) this.pendingTiles.push({ x, y, v });
  }

  // ---------- physics ----------
  buildWorld() {
    this.pendingTiles = [];
    this.world = new Box2D.Dynamics.b2World(new V(0, 0), true);
    const fd = new Box2D.Dynamics.b2FixtureDef();
    const bd = new Box2D.Dynamics.b2BodyDef();
    fd.density = 1; fd.friction = PH.WALL_FRICTION; fd.restitution = PH.WALL_RESTITUTION * 1;
    fd.filter.categoryBits = -1;
    bd.type = Box2D.Dynamics.b2Body.b2_staticBody;
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const t = this.tiles[x][y];
      if (Math.floor(t) !== 1) continue;
      fd.shape = new Box2D.Collision.Shapes.b2PolygonShape();
      if (t === 1.1) fd.shape.SetAsArray([new V(-0.2, 0.2), new V(-0.2, -0.2), new V(0.2, 0.2)]);
      else if (t === 1.2) fd.shape.SetAsArray([new V(-0.2, -0.2), new V(0.2, -0.2), new V(-0.2, 0.2)]);
      else if (t === 1.3) fd.shape.SetAsArray([new V(0.2, -0.2), new V(0.2, 0.2), new V(-0.2, -0.2)]);
      else if (t === 1.4) fd.shape.SetAsArray([new V(0.2, 0.2), new V(-0.2, 0.2), new V(0.2, -0.2)]);
      else fd.shape.SetAsBox(0.2, 0.2);
      bd.position.Set(PH.TILE * x, PH.TILE * y);
      this.world.CreateBody(bd).CreateFixture(fd);
    }
    // Enemy touches are handled in BeginContact, i.e. during Step() *before* the solver runs:
    // the pop explosion is applied, then Box2D still resolves the collision against the (still
    // present) victim. That ordering reproduces real poosts (see tools/calib/poosts.py).
    const listener = new Box2D.Dynamics.b2ContactListener();
    listener.BeginContact = (c) => {
      const a = c.GetFixtureA().GetBody().player, b = c.GetFixtureB().GetBody().player;
      if (a && b && !a.dead && !b.dead && a.team !== b.team) this.enemyContact(a, b);
    };
    this.world.SetContactListener(listener);
    this.afterStep = [];
  }

  createBody(p) {
    const fd = new Box2D.Dynamics.b2FixtureDef();
    const bd = new Box2D.Dynamics.b2BodyDef();
    fd.density = PH.BALL_DENSITY; fd.friction = PH.BALL_FRICTION;
    fd.restitution = PH.BALL_RESTITUTION * this.settings.bounce;
    fd.shape = new Box2D.Collision.Shapes.b2CircleShape(PH.BALL_RADIUS);
    const f = C.getPlayerCollisions(this.settings.ghostMode, p.team === 1);
    fd.filter.categoryBits = f.categoryBits; fd.filter.maskBits = f.maskBits;
    bd.type = Box2D.Dynamics.b2Body.b2_dynamicBody;
    bd.linearDamping = PH.LINEAR_DAMPING; bd.angularDamping = PH.ANGULAR_DAMPING;
    const body = this.world.CreateBody(bd);
    body.CreateFixture(fd);
    body.player = p;
    body.SetPosition(new V(-100, -100));
    body.SetActive(false);
    return body;
  }

  // ---------- clients ----------
  playerCount(team) { return Object.values(this.players).filter((p) => !team || p.team === team).length; }
  spectatorCount() { let n = 0; for (const c of this.clients) if (c.spectator) n++; return n; }

  send(client, ev, data) { try { client.emit(ev, data); } catch (e) { /* closed */ } }
  broadcast(ev, data, filter) { for (const c of this.clients) if (!filter || filter(c)) this.send(c, ev, data); }

  chooseTeam(pref) {
    const r = this.playerCount(1), b = this.playerCount(2);
    if ((pref === 1 || pref === 2) && this.isPrivate) return pref;
    if (pref === 1 && r <= b) return 1;
    if (pref === 2 && b <= r) return 2;
    return r <= b ? 1 : 2;
  }

  // session: { id, name, auth, flair, degree }; opts: { team: 1|2|null, spectate: bool }
  addClient(client, session, opts = {}) {
    if (this.ended) { this.send(client, 'disconnectReason', 'ended'); return; }
    client.session = session;
    client.spectator = !!opts.spectate;
    client.playerId = null;
    this.clients.add(client);

    const s = this.settings;
    this.send(client, 'map', { tiles: this.tiles, splats: [], info: Object.assign({ gameMode: 'normal' }, this.map.info), id: this.id });
    this.send(client, 'clientInfo', {
      gameId: this.id, gameUuid: this.uuid, state: 9, map: this.mapName, mapfile: this.mapName,
      eventTextures: {}, eventSounds: [], eventMusic: [], eventGraphics: [], eventScripts: [], eventSplats: null, eventFlairs: [],
      gameMode: 'classic', classicGameMode: 'ctf', scoreAlgorithm: 'IPMv1.1', worldStarted: true,
      ...(s.mapTestingMode ? { mapTestingMode: true } : {}),
    });
    this.send(client, 'teamNames', { redTeamName: s.redTeamName, blueTeamName: s.blueTeamName });
    this.send(client, 'time', { time: Math.max(0, this.stateEndsAt - this.now()), state: this.state });
    this.send(client, 'spectators', this.spectatorCount());
    if (this.groupId) this.send(client, 'groupId', this.groupId);
    if (s.ghostMode && s.ghostMode !== 'disabled') this.send(client, 'ghostMode', s.ghostMode);
    if (s.gravityWellForce !== 1) this.send(client, 'gravityWellForce', s.gravityWellForce);

    const others = Object.values(this.players).map((p) => this.fullPlayer(p));
    if (client.spectator) {
      this.send(client, 'arrivedInGame', { gameId: this.id, spectateType: 'watching', reconnect: false });
      this.send(client, 'chat', { from: null, message: "You've joined a game as a spectator. Once enough players come online, you'll be redirected to a game. Q/W=Rotate through players. A=Red's flag carrier. S=Blue's flag carrier. C=Center. Z=Toggle auto-zoom. +/-=Zoom in/out.", to: 'all' });
      if (this.groupId) this.send(client, 'chat', { from: null, message: "Press 'g' to chat with your group!", to: 'all' });
      this.broadcast('spectators', this.spectatorCount());
      if (others.length) this.send(client, 'p', others);
      this.send(client, 'score', this.score);
      this.bindClient(client);
      return;
    }

    const team = this.chooseTeam(opts.team);
    const p = this.newPlayer(session, team);
    client.playerId = p.id;
    p.client = client;
    this.send(client, 'id', p.id);
    this.send(client, 'arrivedInGame', { gameId: this.id, spectateType: false });
    if (!session.auth) this.send(client, 'chat', { from: null, message: "Hi! You're currently playing unregistered which means you can't pick a custom name and your chat is limited. To register, click the Log In button on the homepage. Have fun!", to: p.id, c: '#ffffff', for: p.id });
    this.send(client, 'tips', false);
    this.send(client, 'preferredServer', '');
    if (others.length) this.send(client, 'p', others);
    this.players[p.id] = p;
    this.send(client, 'p', [this.fullPlayer(p)]);
    this.broadcast('score', this.score);
    this.broadcast('chat', { from: null, message: `${p.name} has joined the ${team === 1 ? 'Red' : 'Blue'} team.`, to: 'all', for: p.id, icon: team === 1 ? 'join1' : 'join2' });
    this.spawnPlayer(p, 0);
    this.broadcastP([this.fullPlayer(p)], (c) => c !== client);
    this.bindClient(client);
  }

  newPlayer(session, team) {
    const id = this.nextPlayerId++;
    const p = {
      id, sessionId: session.id, name: session.auth ? session.name : (session.name === 'Some Ball' || !session.name ? 'Some Ball ' + id : session.name),
      newPlayer: !session.auth, team, flag: null, potatoFlag: null, selfDestructSoon: null,
      jukeJuice: false, grip: false, speed: false, tagpro: false, bomb: false, dead: true, directSet: false,
      's-tags': 0, 's-pops': 0, 's-grabs': 0, 's-returns': 0, 's-captures': 0, 's-drops': 0, 's-support': 0,
      's-hold': 0, 's-prevent': 0, 's-powerups': 0, 's-flaccids': 0, 's-handoffs': 0, 's-goodHandoffs': 0,
      score: 0, oscore: 0, dscore: 0, tagcoins: 0, up: 0, down: 0, left: 0, right: 0,
      ms: PH.MAX_SPEED * this.settings.topspeed, ac: PH.ACCEL * this.settings.accel, den: 1,
      playTime: '00:00', afk: false, pending: false, skill: null, tier: null, subTier: null,
      lx: 0, ly: 0, a: 0, ra: 0,
    };
    Object.defineProperty(p, 'draw', { value: false, writable: true, enumerable: false });
    if (session.auth) Object.assign(p, { auth: session.auth, flair: session.flair || null, degree: session.degree || 0 });
    Object.defineProperties(p, {
      body: { value: null, writable: true },
      keys: { value: { up: false, down: false, left: false, right: false } },
      sent: { value: {}, writable: true },       // last values sent, for delta compression
      lastInput: { value: this.now(), writable: true },
      afkWarned: { value: false, writable: true },
      joinedAt: { value: this.now(), writable: true },
      effects: { value: {}, writable: true },    // name -> expiry timer
      respawnAt: { value: 0, writable: true },
      touching: { value: new Set(), writable: true },
      portalCooldownUntil: { value: 0, writable: true },
      client: { value: null, writable: true },
      tagproTags: { value: 0, writable: true },
    });
    p.body = this.createBody(p);
    return p;
  }

  fullPlayer(p) {
    const o = {};
    for (const k of Object.keys(p)) o[k] = p[k];
    if (!p.dead && p.body.IsActive()) { const pos = p.body.GetPosition(); o.rx = r2(pos.x); o.ry = r2(pos.y); }
    o.draw = !p.dead;
    return o;
  }

  bindClient(client) {
    client.onEvent = (ev, data) => this.handle(client, ev, data);
  }

  removeClient(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    const p = client.playerId && this.players[client.playerId];
    if (p) {
      if (p.flag) this.returnFlag(p, null, true);
      this.world.DestroyBody(p.body);
      delete this.players[p.id];
      this.broadcast('playerLeft', p.id);
      this.broadcast('chat', { from: null, message: `${p.name} has left the ${p.team === 1 ? 'Red' : 'Blue'} team.`, to: 'all', for: p.id, icon: p.team === 1 ? 'leave1' : 'leave2' });
      if (!this.ended && this.state !== STATES.COUNTDOWN && this.playerCount() === 0) this.end(this.score.r > this.score.b ? 'red' : this.score.b > this.score.r ? 'blue' : 'tie', false);
      else if (!this.ended && this.state !== STATES.COUNTDOWN && (this.playerCount(1) === 0 || this.playerCount(2) === 0) && this.isPrivate === false) { /* public: keep playing, joiner refills */ }
    } else if (client.spectator) this.broadcast('spectators', this.spectatorCount());
    if (this.clients.size === 0) this.onEmpty(this);
  }

  // ---------- input ----------
  handle(client, ev, d) {
    const p = client.playerId && this.players[client.playerId];
    switch (ev) {
      case 'keydown': case 'keyup': {
        if (!p || !d || !(d.k in p.keys || d.k === 'space')) return;
        const down = ev === 'keydown';
        if (d.k === 'space') { p.lastInput = this.now(); if (down) this.spacebar(p); return; }
        p.keys[d.k] = down;
        p.lastInput = this.now();
        if (p.afk) { p.afk = false; }
        const seq = Number(d.t) || 0;
        p[d.k] = down ? seq : -seq;
        this.queue(p, d.k);
        break;
      }
      case 'chat': {
        if (!d || typeof d.message !== 'string') return;
        const msg = d.message.slice(0, 120);
        if (!msg.trim()) return;
        if (!p) { if (d.toAll) this.broadcast('chat', { from: client.session.name, message: msg, to: 'all' }); return; }
        if (d.toAll) this.broadcast('chat', { from: p.id, message: msg, to: 'all' });
        else this.broadcast('chat', { from: p.id, message: msg, to: 'team' }, (c) => c.playerId && this.players[c.playerId] && this.players[c.playerId].team === p.team);
        break;
      }
      case 'switch': {
        if (!p) return;
        const other = p.team === 1 ? 2 : 1;
        if (this.playerCount(other) > this.playerCount(p.team) && !this.isPrivate) return;
        if (p.flag) this.returnFlag(p, null, true);
        p.team = other;
        const f = C.getPlayerCollisions(this.settings.ghostMode, other === 1);
        const fix = p.body.GetFixtureList(); const fd = fix.GetFilterData(); fd.categoryBits = f.categoryBits; fd.maskBits = f.maskBits; fix.SetFilterData(fd);
        this.queue(p, 'team');
        this.broadcast('chat', { from: null, message: `${p.name} has switched to the ${other === 1 ? 'Red' : 'Blue'} team.`, to: 'all', for: p.id, icon: other === 1 ? 'join1' : 'join2' });
        this.pop(p, null, { silent: true });
        break;
      }
      case 'name': {
        if (!p || typeof d !== 'string') return;
        const n = d.trim().slice(0, 12);
        if (!n) return;
        p.name = n; this.queue(p, 'name');
        break;
      }
      case 'p': if (d && d.id != null) this.send(client, 'pr', d.id); break;
      case 'spectate': case 'modSpectate': break;
      case 'mapRating': case 'preferredServer': case 'tips': case 'touch': case 'pings': break;
      case 'mark': if (p) this.broadcast('mark', p.id); break;
      case 'resetMap': if (p && this.settings.mapTestingMode) this.resetMap(); break;
      default: break;
    }
  }

  // ---------- update packets ----------
  queue(p, ...fields) {
    if (!this.dirty) this.dirty = new Map();
    let set = this.dirty.get(p.id);
    if (!set) this.dirty.set(p.id, (set = new Set()));
    for (const f of fields) set.add(f);
  }

  broadcastP(u, filter) { if (u.length) this.broadcast('p', { u, t: this.tick }, filter); }

  flushDirty() {
    if (!this.dirty || !this.dirty.size) return;
    const u = [];
    for (const [id, fields] of this.dirty) {
      const p = this.players[id];
      if (!p) continue;
      const o = { id };
      for (const f of fields) {
        if (f === 'pos') Object.assign(o, this.posDelta(p, true));
        else o[f] = p[f];
      }
      u.push(o);
    }
    this.dirty.clear();
    this.broadcastP(u);
  }

  posDelta(p, force) {
    if (p.dead || !p.body.IsActive()) return {};
    const pos = p.body.GetPosition(), vel = p.body.GetLinearVelocity();
    const cur = { rx: r2(pos.x), ry: r2(pos.y), lx: r2(vel.x), ly: r2(vel.y), a: r2(p.body.GetAngularVelocity()), ra: r2(p.body.GetAngle()) };
    const o = {};
    for (const k in cur) if (force || p.sent[k] !== cur[k]) { o[k] = cur[k]; p.sent[k] = cur[k]; }
    return o;
  }

  snapshot() {
    const u = [];
    for (const p of Object.values(this.players)) {
      const d = this.posDelta(p, false);
      if (Object.keys(d).length) u.push(Object.assign({ id: p.id }, d));
    }
    this.broadcastP(u);
  }

  // ---------- spawning / popping ----------
  pickSpawn(team) {
    const list = this.spawnTiles[team];
    const total = list.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total, s = list[0];
    for (const c of list) { r -= c.weight; if (r <= 0) { s = c; break; } }
    for (let i = 0; i < 30; i++) {
      const ang = Math.random() * Math.PI * 2, dist = Math.random() * (s.radius || 0);
      const x = Math.round(s.x + Math.cos(ang) * dist), y = Math.round(s.y + Math.sin(ang) * dist);
      if (x >= 0 && y >= 0 && x < this.W && y < this.H && this.tiles[x][y] === T.FLOOR) return { x, y };
    }
    return { x: s.x, y: s.y };
  }

  respawnDelay() {
    let d = this.settings.playerRespawnTime;
    if (this.state === STATES.OVERTIME && this.settings.overtimeRespawnIncrement) {
      const periods = Math.floor((this.now() - this.overtimeStartedAt) / 60000) + 1;
      d += periods * this.settings.overtimeRespawnIncrement;
    }
    return d;
  }

  spawnPlayer(p, wait) {
    const t = this.pickSpawn(p.team);
    const px = t.x * PH.TILE, py = t.y * PH.TILE;
    this.broadcast('spawn', { x: px * PH.SCALE, y: py * PH.SCALE, t: p.team, w: wait });
    const done = () => {
      if (!this.players[p.id] || this.ended) return;
      p.dead = false;
      p.body.SetActive(true);
      p.body.SetPosition(new V(px, py));
      p.body.SetLinearVelocity(new V(0, 0));
      p.body.SetAngularVelocity(0);
      p.sent = {};
      p.draw = true;
      this.queue(p, 'dead', 'draw');
      this.directSet(p);
    };
    if (wait) { p.respawnAt = this.now() + wait; this.later(wait, done); }
    else if (this.world.IsLocked()) this.afterStep.push(done); else done();
  }

  // tells clients to place the ball exactly (no reconcile easing); reset on the next tick
  directSet(p) {
    p.directSet = true;
    this.queue(p, 'directSet', 'pos');
    (this.resetDirectSet || (this.resetDirectSet = new Set())).add(p);
  }

  later(ms, fn) { const h = setTimeout(() => { if (!this.closed) fn(); }, ms); this.timers.push(h); return h; }

  // killer: player or null; opts.silent: no stats/sounds (team switch)
  pop(p, killer, opts = {}) {
    if (p.dead) return;
    const pos = p.body.GetPosition();
    const at = { x: pos.x, y: pos.y };
    p.dead = true;
    p.draw = false;
    const removeBody = () => { p.body.SetLinearVelocity(new V(0, 0)); p.body.SetActive(false); };
    if (this.world.IsLocked()) this.afterStep.push(removeBody); else removeBody();
    for (const k of ['tagpro', 'bomb', 'jukeJuice', 'grip', 'speed']) if (p[k]) { p[k] = false; this.queue(p, k); }
    for (const h of Object.values(p.effects)) clearTimeout(h);
    p.effects = {}; p.ms = PH.MAX_SPEED * this.settings.topspeed; p.ac = PH.ACCEL * this.settings.accel;
    this.queue(p, 'dead', 'draw', 'ms', 'ac');
    if (!opts.silent) {
      p['s-pops']++; this.queue(p, 's-pops');
      if (killer) { killer['s-tags']++; this.queue(killer, 's-tags'); }
      this.broadcast('splat', { x: Math.round(at.x * PH.SCALE), y: Math.round(at.y * PH.SCALE), t: p.team, temp: false });
      this.broadcast('sound', { s: 'pop', v: 1 });
      if (this.settings.poosts) this.explode(at, TU.POP_RADIUS, TU.POP_STRENGTH, p);
    }
    if (p.flag) this.returnFlag(p, killer);
    this.spawnPlayer(p, this.respawnDelay());
  }

  explode(at, radius, strength, except) {
    for (const o of Object.values(this.players)) {
      if (o === except || o.dead) continue;
      const pos = o.body.GetPosition();
      const dx = pos.x - at.x, dy = pos.y - at.y, d = Math.hypot(dx, dy);
      if (d >= radius || d < 1e-6) continue;
      const k = strength * (radius - d);
      const v = o.body.GetLinearVelocity();
      o.body.SetLinearVelocity(new V(v.x + dx / d * k, v.y + dy / d * k));
      this.queue(o, 'pos');
    }
  }

  // ---------- flags ----------
  flagAtHome(team) { const h = this.flagHome[team]; return h && this.tiles[h.x][h.y] === (team === 1 ? T.RED_FLAG : T.BLUE_FLAG); }

  grabFlag(p, team) {
    const h = this.flagHome[team];
    this.setTile(h.x, h.y, team === 1 ? '3.1' : '4.1');
    p.flag = team; p['s-grabs']++;
    p.grabbedAt = this.now();
    p.invincibleUntil = this.now() + TU.GRAB_INVINCIBLE_MS;
    this.queue(p, 'flag', 's-grabs');
    for (const c of this.clients) {
      const viewer = c.playerId && this.players[c.playerId];
      const friendly = viewer && viewer.team === p.team;
      this.send(c, 'sound', friendly ? { s: 'friendlyalert', v: 1 } : { s: 'alert', v: viewer ? 1 : 0.25 });
    }
  }

  returnFlag(p, killer, silent) {
    const team = p.flag;
    p.flag = null; this.queue(p, 'flag');
    const h = this.flagHome[team];
    if (h) this.setTile(h.x, h.y, team === 1 ? T.RED_FLAG : T.BLUE_FLAG);
    if (silent) return;
    p['s-drops']++; this.queue(p, 's-drops');
    if (killer) { killer['s-returns']++; this.queue(killer, 's-returns'); }
    for (const c of this.clients) {
      const viewer = c.playerId && this.players[c.playerId];
      const friendly = viewer && viewer.team === p.team;
      this.send(c, 'sound', { s: friendly ? 'friendlydrop' : 'drop', v: 1 });
    }
  }

  capture(p) {
    const team = p.flag;
    p.flag = null; p['s-captures']++;
    this.queue(p, 'flag', 's-captures');
    const h = this.flagHome[team];
    this.setTile(h.x, h.y, team === 1 ? T.RED_FLAG : T.BLUE_FLAG);
    if (p.team === 1) this.score.r++; else this.score.b++;
    for (const c of this.clients) {
      const viewer = c.playerId && this.players[c.playerId];
      const friendly = viewer ? viewer.team === p.team : true;
      this.send(c, 'sound', { s: friendly ? 'cheering' : 'sigh', v: friendly ? 1 : 0.75 });
    }
    this.broadcast('score', this.score);
    this.checkWinConditions(true);
  }

  // ---------- powerups / timed tiles ----------
  enabledPups() {
    const s = this.settings, out = [];
    if (s.disableAllPups) return out;
    if (s.powerupJukeJuice) out.push(1);
    if (s.powerupRollingBomb) out.push(2);
    if (s.powerupTagPro) out.push(3);
    if (s.powerupTopSpeed) out.push(4);
    return out;
  }

  initPowerups() {
    this.pupTiles = [];
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) if (this.tiles[x][y] === T.POWERUP) this.pupTiles.push({ x, y });
  }

  // at game start (powerupDelay): preview the next pup, spawn after one respawn cycle
  startPowerups() {
    for (const t of this.pupTiles) {
      if (this.settings.powerupDelay) this.schedulePowerup(t.x, t.y);
      else { const k = this.randomPup(); if (k) this.setTile(t.x, t.y, 6 + k / 10); }
    }
  }

  randomPup() { const e = this.enabledPups(); return e.length ? e[Math.floor(Math.random() * e.length)] : 0; }

  schedulePowerup(x, y) {
    const k = this.randomPup();
    if (!k) { this.setTile(x, y, T.POWERUP); return; }
    const base = 6 + k / 10;
    this.setTile(x, y, this.settings.pupIndicators ? Number(base.toFixed(1) + '2') : T.POWERUP);
    this.timedRespawn(x, y, this.settings.powerupRespawnTime, base, (i) => Number(base.toFixed(1) + String(i).padStart(2, '0')));
  }

  // generic respawn with 12 x 250ms warning frames (e.g. 5.101 .. 5.112), as measured in replays
  bumpTile(x, y) { const k = x + ',' + y; return (this.tileGen[k] = (this.tileGen[k] || 0) + 1); }
  tileCurrent(x, y, gen) { return this.tileGen[x + ',' + y] === gen; }

  timedRespawn(x, y, total, finalTile, warnTile) {
    const gen = this.bumpTile(x, y);
    const warnTotal = TU.WARNING_FRAMES * TU.WARNING_FRAME_MS;
    const warn = this.settings.respawnWarnings && total > warnTotal;
    const idle = warn ? total - warnTotal : total;
    this.later(idle, () => {
      if (!this.tileCurrent(x, y, gen)) return;
      if (!warn) return this.setTile(x, y, finalTile);
      let i = 1;
      const step = () => {
        if (!this.tileCurrent(x, y, gen)) return;
        if (i > TU.WARNING_FRAMES) return this.setTile(x, y, finalTile);
        this.setTile(x, y, warnTile(i));
        i++;
        this.later(TU.WARNING_FRAME_MS, step);
      };
      step();
    });
  }

  givePowerup(p, kind) {
    const s = this.settings;
    const name = PUPS[kind];
    const dur = { jukeJuice: s.powerupJukeJuiceDuration, rollingBomb: s.powerupRollingBombDuration, tagpro: s.powerupTagproDuration, topSpeed: 20000 }[name];
    p['s-powerups']++; this.queue(p, 's-powerups');
    this.broadcast('sound', { s: 'powerup', v: 1 }, (c) => c.playerId === p.id);
    if (p.effects[name]) clearTimeout(p.effects[name]);
    if (name === 'jukeJuice') { p.jukeJuice = true; p.grip = this.now() + dur; p.ac = TU.JUKE_JUICE_ACCEL * s.accel; this.queue(p, 'jukeJuice', 'grip', 'ac'); }
    if (name === 'rollingBomb') { p.bomb = true; this.queue(p, 'bomb'); }
    if (name === 'tagpro') { p.tagpro = true; p.tagproTags = 0; this.queue(p, 'tagpro'); }
    if (name === 'topSpeed') { p.speed = true; p.ms = TU.TOP_SPEED_MAX * s.topspeed; this.queue(p, 'speed', 'ms'); }
    p.effects[name] = this.later(dur, () => this.clearEffect(p, name));
    if (name === 'jukeJuice') p.jjBoostUsed = false;
  }

  // spacebar: received from the client; what it does (juke juice boost / rolling bomb detonation
  // settings) isn't confirmed yet, so it does nothing for now.
  spacebar(p) {}

  detonateRollingBomb(x) {
    const s = this.settings;
    x.bomb = false; this.queue(x, 'bomb'); clearTimeout(x.effects.rollingBomb); delete x.effects.rollingBomb;
    const pos = x.body.GetPosition();
    this.broadcast('bomb', { x: pos.x * PH.SCALE, y: pos.y * PH.SCALE, type: 1 });
    this.explosionSound({ x: pos.x, y: pos.y });
    this.explode({ x: pos.x, y: pos.y }, TU.ROLLING_BOMB_RADIUS * s.rollingBombDistanceMultipler, TU.ROLLING_BOMB_STRENGTH * s.rollingBombForceMultipler, x);
  }

  clearEffect(p, name) {
    if (!this.players[p.id]) return;
    delete p.effects[name];
    const s = this.settings;
    if (name === 'jukeJuice') { p.jukeJuice = false; p.grip = false; p.ac = PH.ACCEL * s.accel; this.queue(p, 'jukeJuice', 'grip', 'ac'); }
    if (name === 'rollingBomb') { p.bomb = false; this.queue(p, 'bomb'); }
    if (name === 'tagpro') { p.tagpro = false; this.queue(p, 'tagpro'); }
    if (name === 'topSpeed') { p.speed = false; p.ms = PH.MAX_SPEED * s.topspeed; this.queue(p, 'speed', 'ms'); }
  }

  // ---------- tile interactions ----------
  tileAt(px, py) {
    const x = Math.round(px / PH.TILE), y = Math.round(py / PH.TILE);
    return (x >= 0 && y >= 0 && x < this.W && y < this.H) ? { x, y, t: this.tiles[x][y] } : null;
  }

  // tiles whose square overlaps the ball
  overlappingTiles(pos) {
    const out = [], R = PH.BALL_RADIUS, h = PH.TILE / 2;
    const x0 = Math.floor((pos.x - R + h) / PH.TILE), x1 = Math.floor((pos.x + R + h) / PH.TILE);
    const y0 = Math.floor((pos.y - R + h) / PH.TILE), y1 = Math.floor((pos.y + R + h) / PH.TILE);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
      const cx = x * PH.TILE, cy = y * PH.TILE;
      const nx = Math.max(cx - h, Math.min(pos.x, cx + h)), ny = Math.max(cy - h, Math.min(pos.y, cy + h));
      const dist = Math.hypot(pos.x - nx, pos.y - ny);
      out.push({ x, y, t: this.tiles[x][y], center: Math.hypot(pos.x - cx, pos.y - cy), edge: dist });
    }
    return out;
  }

  touches(o, kind) { return o.center < PH.BALL_RADIUS + TU.TOUCH_RADIUS[kind]; }

  tileInteractions(p) {
    const pos = p.body.GetPosition();
    const tiles = this.overlappingTiles(pos);
    let onTeamTile = false;
    const nowTouching = new Set();
    for (const o of tiles) {
      if (p.dead) return;
      const t = o.t, key = o.x + ',' + o.y;
      const base = typeof t === 'string' ? parseFloat(t) : t;
      if (o.edge < PH.BALL_RADIUS - 0.01 && ((base === T.RED_TILE && p.team === 1) || (base === T.BLUE_TILE && p.team === 2))) onTeamTile = true;
      switch (base) {
        case T.SPIKE: if (this.touches(o, 'spike')) this.pop(p, null); break;
        case T.RED_FLAG: case T.BLUE_FLAG: {
          if (!this.touches(o, 'flag')) break;
          const team = base === T.RED_FLAG ? 1 : 2;
          if (team !== p.team && !p.flag) this.grabFlag(p, team);
          else if (team === p.team && p.flag && p.flag !== p.team) this.capture(p);
          break;
        }
        case T.BOOST: case T.RED_BOOST: case T.BLUE_BOOST: {
          if (!this.touches(o, 'boost')) break;
          if ((base === T.RED_BOOST && p.team !== 1) || (base === T.BLUE_BOOST && p.team !== 2)) break;
          this.boost(p);
          const empty = base + 0.1;
          this.setTile(o.x, o.y, String(Number(empty.toFixed(1))));
          this.timedRespawn(o.x, o.y, this.settings.speedPadRespawnTime, base, (i) => Number(empty.toFixed(1) + String(i).padStart(2, '0')));
          break;
        }
        case 6.1: case 6.2: case 6.3: case 6.4: {
          if (!this.touches(o, 'powerup')) break;
          this.givePowerup(p, Math.round((base - 6) * 10));
          this.schedulePowerup(o.x, o.y);
          break;
        }
        case T.BOMB: {
          if (!this.touches(o, 'bomb')) break;
          this.detonateBomb(o.x, o.y);
          break;
        }
        case T.BUTTON: if (this.touches(o, 'button')) nowTouching.add(key); break;
        case T.GATE_ON: case T.GATE_RED: case T.GATE_BLUE: {
          if (o.edge >= PH.BALL_RADIUS - 0.02) break;
          if (base === T.GATE_ON || (base === T.GATE_RED && p.team === 2) || (base === T.GATE_BLUE && p.team === 1)) this.pop(p, null);
          break;
        }
        case T.PORTAL: case T.RED_PORTAL: case T.BLUE_PORTAL: {
          if (typeof t === 'string' || !this.touches(o, 'portal')) break;
          if ((base === T.RED_PORTAL && p.team !== 1) || (base === T.BLUE_PORTAL && p.team !== 2)) break;
          this.teleport(p, o.x, o.y, base);
          break;
        }
        default: break;
      }
    }
    // buttons: track which buttons this player holds
    for (const key of p.touching) if (!nowTouching.has(key)) this.releaseButton(key, p);
    for (const key of nowTouching) if (!p.touching.has(key)) this.pressButton(key, p);
    p.touching = nowTouching;
    // team tiles speed the owner team up
    const ac = (p.jukeJuice ? TU.JUKE_JUICE_ACCEL : onTeamTile ? TU.TEAM_TILE_ACCEL : PH.ACCEL) * this.settings.accel;
    if (Math.abs(ac - p.ac) > 1e-9) { p.ac = ac; this.queue(p, 'ac'); }
  }

  boost(p) {
    const v = p.body.GetLinearVelocity();
    let dx = v.x, dy = v.y;
    const k = p.keys;
    if (Math.hypot(dx, dy) < 1e-3) { dx = (k.right ? 1 : 0) - (k.left ? 1 : 0); dy = (k.down ? 1 : 0) - (k.up ? 1 : 0); }
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    p.body.SetLinearVelocity(new V(dx / len * TU.BOOST_SPEED, dy / len * TU.BOOST_SPEED));
    this.broadcast('sound', { s: 'burst', v: 1 });
    this.queue(p, 'pos');
  }

  detonateBomb(x, y) {
    const at = { x: x * PH.TILE, y: y * PH.TILE };
    this.setTile(x, y, '10.1');
    this.broadcast('bomb', { x: x * 40, y: y * 40, type: 2 });
    this.explosionSound(at);
    this.explode(at, TU.BOMB_RADIUS, TU.BOMB_STRENGTH, null);
    this.timedRespawn(x, y, this.settings.dynamiteRespawnTime, T.BOMB, (i) => Number('10.1' + String(i).padStart(2, '0')));
  }

  explosionSound(at) {
    for (const c of this.clients) {
      const v = c.playerId && this.players[c.playerId];
      let vol = 1;
      if (v && !v.dead) { const pos = v.body.GetPosition(); vol = Math.min(1, 1 / Math.max(1, Math.hypot(pos.x - at.x, pos.y - at.y) * 2.5) ** 2 * 1); }
      this.send(c, 'sound', { s: 'explosion', v: vol });
    }
  }

  teleport(p, x, y, base) {
    if (this.now() < p.portalCooldownUntil) return;
    const key = x + ',' + y;
    const conf = this.map.portals[key];
    if (!conf || !conf.destination) return;
    const d = conf.destination;
    const cooldown = conf.cooldown == null ? 4000 : conf.cooldown;
    const v = p.body.GetLinearVelocity();
    p.body.SetPosition(new V(d.x * PH.TILE, d.y * PH.TILE));
    p.body.SetLinearVelocity(new V(v.x, v.y));
    p.portalCooldownUntil = this.now() + 200;
    this.broadcast('sound', { s: 'teleport', v: 1 });
    // real server: flash + explosion at the destination, and directSet so clients snap instead of easing
    this.broadcast('bomb', { x: d.x * 40, y: d.y * 40, type: 3 });
    if (this.settings.poosts) this.explode({ x: d.x * PH.TILE, y: d.y * PH.TILE }, TU.PORTAL_RADIUS, TU.PORTAL_STRENGTH, p);
    this.directSet(p);
    if (cooldown > 0) {
      const cool = (base + 0.1).toFixed(1);
      this.setTile(x, y, cool);
      const dk = d.x + ',' + d.y;
      const destIsPortal = this.map.portals[dk] && Math.floor(parseFloat(this.tiles[d.x][d.y])) === Math.floor(base) && typeof this.tiles[d.x][d.y] === 'number';
      if (destIsPortal && this.map.portals[dk].destination) this.setTile(d.x, d.y, (parseFloat(this.tiles[d.x][d.y]) + 0.1).toFixed(1));
      const gen = this.bumpTile(x, y);
      this.later(cooldown, () => {
        if (!this.tileCurrent(x, y, gen)) return;
        this.setTile(x, y, base);
        if (destIsPortal) this.setTile(d.x, d.y, Math.floor(parseFloat(this.tiles[d.x][d.y])) === T.PORTAL || [T.RED_PORTAL, T.BLUE_PORTAL].includes(Math.floor(parseFloat(this.tiles[d.x][d.y]))) ? Math.round(parseFloat(this.tiles[d.x][d.y]) - 0.1) : this.tiles[d.x][d.y]);
      });
    }
  }

  pressButton(key, p) {
    (this.buttonsHeld[key] || (this.buttonsHeld[key] = new Set())).add(p.id);
    this.updateGates(key);
  }

  releaseButton(key, p) {
    const s = this.buttonsHeld[key];
    if (s) s.delete(p.id);
    this.updateGates(key);
  }

  // a toggle entry names one gate tile; the whole 8-connected gate it belongs to switches
  gateField(toggle) {
    const key = toggle.map((g) => g.pos.x + ',' + g.pos.y).join(';');
    this.gateFieldCache = this.gateFieldCache || {};
    if (this.gateFieldCache[key]) return this.gateFieldCache[key];
    const isGate = (x, y) => x >= 0 && y >= 0 && x < this.W && y < this.H && Math.floor(parseFloat(this.map.tiles[x][y])) === T.GATE_OFF;
    const seen = new Set(), out = [];
    for (const g of toggle) {
      const stack = [[g.pos.x, g.pos.y]];
      while (stack.length) {
        const [x, y] = stack.pop(), k = x + ',' + y;
        if (seen.has(k) || !isGate(x, y)) continue;
        seen.add(k); out.push([x, y]);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) stack.push([x + dx, y + dy]);
      }
    }
    return (this.gateFieldCache[key] = out);
  }

  updateGates(buttonKey) {
    const sw = this.map.switches[buttonKey];
    if (!sw || !sw.toggle) return;
    const holders = [...(this.buttonsHeld[buttonKey] || [])].map((id) => this.players[id]).filter((q) => q && !q.dead);
    const red = holders.filter((q) => q.team === 1).length, blue = holders.length - red;
    for (const [gx, gy] of this.gateField(sw.toggle)) {
      const def = (this.map.fields[gx + ',' + gy] || {}).defaultState || 'off';
      const defTile = { off: T.GATE_OFF, on: T.GATE_ON, red: T.GATE_RED, blue: T.GATE_BLUE }[def.toLowerCase()] ?? T.GATE_OFF;
      let v = defTile;
      if (holders.length) {
        if (defTile === T.GATE_OFF) v = red > blue ? T.GATE_RED : blue > red ? T.GATE_BLUE : T.GATE_ON;
        else if (defTile === T.GATE_ON) v = T.GATE_OFF;
        else if (defTile === T.GATE_RED) v = T.GATE_BLUE;
        else if (defTile === T.GATE_BLUE) v = T.GATE_RED;
      }
      if (this.tiles[gx][gy] !== v) { this.setTile(gx, gy, v); this.gatesChanged = true; }
    }
  }

  // ---------- player vs player ----------
  // Enemy touches normally arrive via BeginContact during the step. This catches the rest:
  // contacts that were already touching (e.g. tagpro picked up mid-contact) and pairs that
  // ghost modes filter out of Box2D collisions entirely.
  playerContacts() {
    for (let c = this.world.GetContactList(); c; c = c.GetNext()) {
      if (!c.IsTouching()) continue;
      const a = c.GetFixtureA().GetBody().player, b = c.GetFixtureB().GetBody().player;
      if (a && b && !a.dead && !b.dead && a.team !== b.team) this.enemyContact(a, b);
    }
    if (!this.settings.ghostMode || this.settings.ghostMode === 'disabled') return;
    const ps = Object.values(this.players).filter((p) => !p.dead);
    const reach = PH.BALL_RADIUS * 2;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.dead || b.dead || a.team === b.team) continue;
      const fa = a.body.GetFixtureList().GetFilterData(), fb = b.body.GetFixtureList().GetFilterData();
      if ((fa.maskBits & fb.categoryBits) && (fb.maskBits & fa.categoryBits)) continue; // Box2D handles it
      const pa = a.body.GetPosition(), pb = b.body.GetPosition();
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) <= reach) this.enemyContact(a, b);
    }
  }

  enemyContact(a, b) {
    const s = this.settings;
    const bothFC = a.flag && b.flag;
    const bothTP = a.tagpro && b.tagpro;
    // rolling bombs go off on enemy contact
    for (const [x] of [[a, b], [b, a]]) if (x.bomb) this.detonateRollingBomb(x);
    if (bothFC && s.kissingFCs) return;
    if (bothTP && s.kissingTPs && !(a.flag || b.flag)) return;
    const kills = [];
    if (a.tagpro) kills.push([b, a]);
    if (b.tagpro) kills.push([a, b]);
    if (b.flag && !(bothTP && s.kissingTPs && b.tagpro && !a.tagpro)) kills.push([b, a]);
    if (a.flag) kills.push([a, b]);
    const done = new Set();
    for (const [victim, killer] of kills) {
      if (done.has(victim) || this.now() < (victim.invincibleUntil || 0)) continue;
      if (victim.tagpro && killer.tagpro && s.kissingTPs && !victim.flag) continue;
      done.add(victim);
      if (killer.tagpro && !victim.flag) {
        killer.tagproTags++;
        if (s.tagproMaxTags && killer.tagproTags >= s.tagproMaxTags) this.clearEffect(killer, 'tagpro');
      }
      this.pop(victim, killer);
    }
  }

  resetMap() {
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const orig = this.map.tiles[x][y], cur = this.tiles[x][y];
      const b = Math.floor(parseFloat(orig));
      if (![T.BOOST, T.RED_BOOST, T.BLUE_BOOST, T.BOMB, T.PORTAL, T.RED_PORTAL, T.BLUE_PORTAL, T.POWERUP].includes(b)) continue;
      this.bumpTile(x, y);
      let v = orig;
      if (b === T.POWERUP) { const k = this.randomPup(); v = k ? Number((6 + k / 10).toFixed(1)) : T.POWERUP; }
      if (String(cur) !== String(v)) this.setTile(x, y, v);
    }
  }

  // ---------- main loop ----------
  start() {
    this.startedAt = this.now();
    this.lastTime = this.now();
    this.acc = 0;
    const loop = () => {
      if (this.closed) return;
      const now = this.now();
      this.acc += now - this.lastTime;
      this.lastTime = now;
      let n = 0;
      while (this.acc >= 1000 / 60 && n++ < 10) { this.acc -= 1000 / 60; this.step(); }
      if (n >= 10) this.acc = 0;
      this.loopHandle = setTimeout(loop, 4);
    };
    loop();
  }

  playing() { return [STATES.ACTIVE, STATES.OVERTIME, STATES.CLUTCH].includes(this.state); }

  step() {
    this.tick++;
    const now = this.now();
    this.updateClock(now);
    if (this.playing()) {
      for (const p of Object.values(this.players)) {
        if (p.dead) continue;
        p.body.SetAwake(true);
        const v = p.body.GetLinearVelocity();
        const ms = p.ms, ac = p.ac, k = p.keys;
        if (k.left && v.x > -ms) v.x -= ac;
        if (k.right && v.x < ms) v.x += ac;
        if (k.up && v.y > -ms) v.y -= ac;
        if (k.down && v.y < ms) v.y += ac;
        p.body.SetLinearVelocity(v);
      }
      for (const w of this.gravityWells) {
        for (const p of Object.values(this.players)) {
          if (p.dead) continue;
          const c = p.body.GetWorldCenter();
          const o = new V(c.x - w.x, c.y - w.y);
          const len = o.Length();
          if (len > PH.GRAVITY_WELL_RANGE || len < 1e-6) continue;
          const f = PH.GRAVITY_WELL_FORCE * this.settings.gravityWellForce * p.body.GetMass() / (len * len);
          o.NegativeSelf(); o.Multiply(f);
          p.body.ApplyImpulse(o, c);
        }
      }
      this.world.Step(PH.STEP, PH.VELOCITY_ITERATIONS, PH.POSITION_ITERATIONS);
      for (const fn of this.afterStep.splice(0)) fn();
      for (const p of Object.values(this.players)) if (!p.dead) this.tileInteractions(p);
      this.playerContacts();
      this.afkCheck(now);
      if (this.tick % 60 === 0) this.secondTick(now);
    }
    if (this.pendingTiles.length) { this.broadcast('mapupdate', this.pendingTiles.length === 1 ? this.pendingTiles[0] : this.pendingTiles); this.pendingTiles = []; }
    if (this.pendingDirectReset) {
      for (const p of this.pendingDirectReset) if (this.players[p.id] && p.directSet) { p.directSet = false; this.queue(p, 'directSet'); }
      this.pendingDirectReset = null;
    }
    this.flushDirty();
    if (this.resetDirectSet && this.resetDirectSet.size) { this.pendingDirectReset = this.resetDirectSet; this.resetDirectSet = null; }
    if (this.tick % TU.SNAPSHOT_TICKS === 0) this.snapshot();
  }

  secondTick(now) {
    for (const p of Object.values(this.players)) {
      p.playTime = mmss(now - p.joinedAt); this.queue(p, 'playTime');
      if (p.flag) { p['s-hold']++; this.queue(p, 's-hold'); }
      else if (!p.dead && this.flagAtHome(p.team)) {
        const h = this.flagHome[p.team], pos = p.body.GetPosition();
        if (Math.hypot(pos.x - h.x * PH.TILE, pos.y - h.y * PH.TILE) < 8 * PH.TILE) { p['s-prevent']++; this.queue(p, 's-prevent'); }
      }
      const sc = p['s-captures'] * 100 + p['s-grabs'] * 5 + p['s-tags'] * 5 + p['s-returns'] * 5 + p['s-hold'] + p['s-prevent'] + p['s-powerups'] * 5 - p['s-pops'];
      if (sc !== p.score) { p.score = sc; this.queue(p, 'score'); }
    }
  }

  afkCheck(now) {
    for (const p of Object.values(this.players)) {
      const idle = now - Math.max(p.lastInput, this.startedPlayAt || 0);
      const kickAt = this.settings.mapTestingMode ? TU.MAPTEST_AFK_KICK_MS : TU.AFK_KICK_MS;
      const warnAt = kickAt - (TU.AFK_KICK_MS - TU.AFK_WARN_MS);
      if (idle > kickAt) {
        const c = p.client;
        this.send(c, 'disconnectReason', 'afk');
        this.removeClient(c);
        try { c.disconnect(); } catch (e) { /* ignore */ }
      } else if (idle > warnAt && !p.afkWarned) {
        p.afkWarned = true;
        this.send(p.client, 'chat', { from: null, message: 'MOVE! It looks like you are AFK and we are about to kick you for it!', to: p.id, c: '#ff8f8f', for: p.id });
        this.send(p.client, 'sound', { s: 'bing', v: 1 });
      } else if (idle < warnAt) p.afkWarned = false;
    }
  }

  // ---------- clock / state machine ----------
  setState(state, time) {
    this.state = state;
    this.broadcast('time', { time, state });
  }

  updateClock(now) {
    if (this.ended) return;
    if (now - this.lastClockSync >= TU.CLOCKSYNC_MS) {
      this.lastClockSync = now;
      const time = this.state === STATES.OVERTIME ? now - this.overtimeStartedAt : Math.max(0, this.stateEndsAt - now);
      this.broadcast('clocksync', { time, state: this.state });
    }
    if (this.state === STATES.COUNTDOWN && now >= this.stateEndsAt) {
      this.stateEndsAt = now + this.settings.time * 60000;
      this.startedPlayAt = now;
      this.lastClockSync = now;
      for (const p of Object.values(this.players)) p.lastInput = now;
      this.setState(STATES.ACTIVE, this.stateEndsAt - now);
      this.startPowerups();
      this.broadcast('sound', { s: 'go', v: 1 });
    } else if (this.state === STATES.ACTIVE && now >= this.stateEndsAt) {
      this.timeUp(now);
    }
  }

  timeUp(now) {
    {
      if (this.score.r === this.score.b && this.settings.overtime) {
        this.overtimeStartedAt = now;
        this.setState(STATES.OVERTIME, 1);
        this.broadcast('sound', { s: 'overtime', v: 1 });
        this.broadcast('chat', { from: null, message: 'OVERTIME! Next cap wins.', to: 'all', c: '#D4AF37' });
        if (this.settings.overtimeJukeJuice) for (const p of Object.values(this.players)) this.givePowerup(p, 1);
      } else this.end(this.score.r > this.score.b ? 'red' : this.score.b > this.score.r ? 'blue' : 'tie', false);
    }
  }

  checkWinConditions() {
    const { r, b } = this.score, s = this.settings;
    if (this.state === STATES.OVERTIME && r !== b) return this.end(r > b ? 'red' : 'blue', false);
    if (s.caps && (r >= s.caps || b >= s.caps)) return this.end(r > b ? 'red' : 'blue', false);
    if (s.mercyRule && Math.abs(r - b) >= s.mercyRule) return this.end(r > b ? 'red' : 'blue', true);
  }

  end(winner, isMercy) {
    if (this.ended) return;
    this.ended = true;
    this.state = STATES.ENDED;
    this.broadcast('end', { winner, ranked: false, isMercy: !!isMercy });
    this.onEnd(this, winner);
    this.later(TU.END_LINGER_MS, () => this.close());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.loopHandle);
    for (const h of this.timers) clearTimeout(h);
    for (const c of [...this.clients]) { try { c.disconnect(); } catch (e) { /* ignore */ } }
    this.clients.clear();
    this.onEmpty(this);
  }
}

const api = { GameRoom, PUBLIC_DEFAULTS, T };
if (isNode) module.exports = api;
else globalThis.TPGame = api;
})();
