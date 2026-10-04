// groups.js - TagPro groups (/groups/<id> socket namespace), recoded from captures of the
// real group server (ref/group-capture-*.ndjson, ref/live*/group.ndjson) and global-group.js.
const defaults = require('./groupDefaults.json');
const sessions = require('./sessions');
const presets = require('./preset');
const { TRUST_GHOST } = require('../engine/game');

const TEAM = { PLAYING: 0, RED: 1, BLUE: 2, SPECTATING: 3, WAITING: 4 };
const MAX_MEMBERS = 32;
const LEAVE_GRACE_MS = 30000; // member kept while navigating group -> joiner -> game pages

const groups = new Map();
let gamesApi = null; // set by index.js: { launchGroupGame(group), endGame(gameId) }

function groupId() {
  let s;
  do { s = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join(''); } while (groups.has(s));
  return s;
}

const defaultSettings = () => Object.fromEntries(defaults.settings.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));

// The page sends everything as strings; the real server stores and echoes typed values.
function coerce(name, value, current) {
  const def = defaults.settings.find(([k]) => k === name);
  const ref = def ? def[1] : current;
  if (Array.isArray(ref)) {
    if (Array.isArray(value)) return value.map(String);
    return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof ref === 'boolean') return value === true || value === 'true';
  if (typeof ref === 'number') { const n = Number(value); return Number.isFinite(n) ? n : ref; }
  if (ref === null && (value === '' || value === 'null')) return null;
  // the three powerup durations default to strings on the real server but are stored as numbers once
  // set (so a preset still includes them after being set back to 20 seconds)
  if (/^powerup\w+Duration$/.test(name)) { const n = Number(value); return Number.isFinite(n) ? n : current; }
  return value == null ? value : String(value);
}

class Group {
  constructor({ name, isPrivate, discoverable }) {
    this.id = groupId();
    this.settings = defaultSettings();
    this.settings.name = (name || '').trim().slice(0, 32) || 'Some Group';
    this.settings.isPrivate = !!isPrivate;
    this.settings.discoverable = !!discoverable;
    this.settings.groupId = this.id;
    this.members = new Map(); // sessionId -> member
    this.game = { gameServer: null, gameId: null };
    this.nsp = null;
    this.modeMap = null; // eggball / ice hockey switch to their own map without broadcasting it (presets save it)
    groups.set(this.id, this);
  }

  memberList() { return [...this.members.values()]; }

  publicMember(m) {
    const o = { id: m.id, name: m.name, auth: m.auth, lastSeen: m.lastSeen };
    if (m.leader) o.leader = true;
    Object.assign(o, { team: m.team, location: m.location, flair: m.flair, mutedGroupIds: m.mutedGroupIds, mod: null });
    return o;
  }

  broadcastMember(m) { this.nsp.emit('member', this.publicMember(m)); }
  broadcastSetting(name) { this.nsp.emit('setting', { name, value: this.settings[name] }); }
  systemChat(message) { this.nsp.emit('chat', { from: null, message, to: 'group', auth: null }); }

  defaultTeam(isLeader) {
    if (!this.settings.isPrivate) return TEAM.PLAYING;
    return isLeader ? TEAM.RED : TEAM.WAITING;
  }

  join(socket, session) {
    let m = this.members.get(session.id);
    const isNew = !m;
    if (isNew) {
      if (this.members.size >= MAX_MEMBERS) { socket.emit('full'); socket.disconnect(); return; }
      const leader = this.members.size === 0;
      m = {
        id: session.id, session, name: session.name, auth: session.auth, lastSeen: Date.now(),
        leader, team: this.defaultTeam(leader), location: '???', flair: session.flair,
        mutedGroupIds: {}, sockets: new Set(), leaveTimer: null,
      };
      for (const o of this.members.values()) { o.mutedGroupIds[m.id] = false; m.mutedGroupIds[o.id] = false; }
      this.members.set(m.id, m);
      session.groupId = this.id;
    }
    clearTimeout(m.leaveTimer);
    m.sockets.add(socket);
    m.lastSeen = Date.now();

    this.broadcastMember(m);
    socket.emit('you', m.id);
    for (const [name] of defaults.settings) socket.emit('setting', { name, value: this.settings[name] });
    socket.emit('game', this.game);
    socket.emit('servers', defaults.servers.slice(0, 1).map((s) => ({ ...s, name: 'Local', key: 'local' })));
    for (const o of this.members.values()) socket.emit('member', this.publicMember(o));
    socket.emit('loaded');
    if (isNew) this.systemChat(`${m.name} has joined the group.`);

    socket.on('touch', (location) => {
      m.lastSeen = Date.now();
      if (typeof location === 'string' || location === null) m.location = location || m.location;
      this.broadcastMember(m);
    });
    socket.on('chat', (message) => {
      if (typeof message !== 'string' || !message.trim()) return;
      this.nsp.emit('chat', { from: m.name, message: message.slice(0, 120), to: 'group', auth: m.auth });
    });
    socket.on('team', (d) => {
      const target = d && this.members.get(d.id);
      const team = d && parseInt(d.team, 10);
      if (!target || !Object.values(TEAM).includes(team)) return;
      if (!m.leader && !(this.settings.selfAssignment && target === m)) return;
      target.team = team;
      this.broadcastMember(target);
    });
    socket.on('setting', (d) => {
      if (!m.leader || !d || typeof d.name !== 'string') return;
      let name = d.name === 'groupName' ? 'name' : d.name;
      if (!(name in this.settings)) return;
      this.settings[name] = coerce(name, d.value, this.settings[name]);
      // local trust only works when players can't bump each other
      if (this.settings.localTrust && !TRUST_GHOST.has(this.settings.ghostMode)) {
        this.settings.localTrust = false;
        if (name !== 'localTrust') this.broadcastSetting('localTrust');
      }
      if (name === 'name') this.settings.name = String(this.settings.name).slice(0, 32) || 'Some Group';
      if (name === 'isPrivate') {
        for (const o of this.members.values()) { o.team = this.defaultTeam(o.leader); this.broadcastMember(o); }
      }
      // mode side effects, as on the real server: eggball / ice hockey quietly use their own map,
      // gravity resets the map to random; picking a map afterwards overrides either
      if (name === 'mode') {
        this.modeMap = presets.MODE_MAPS[this.settings.mode] || null;
        if (this.settings.mode === 'gravity' && this.settings.map !== 'random') { this.settings.map = 'random'; this.broadcastSetting('map'); }
      }
      if (name === 'map') this.modeMap = null;
      if (name === 'map' && String(this.settings.map).startsWith('fm_id/')) {
        this.settings.mapId = String(this.settings.map).slice(6);
        this.broadcastSetting('mapId');
      }
      this.broadcastSetting(name);
    });
    socket.on('leader', (id) => {
      const target = this.members.get(id);
      if (!m.leader || !target || target === m) return;
      m.leader = false; target.leader = true;
      this.broadcastMember(m); this.broadcastMember(target);
      this.systemChat(`${target.name} is now the leader.`);
    });
    socket.on('kick', (id) => {
      const target = this.members.get(id);
      if (!m.leader || !target || target === m) return;
      for (const s of target.sockets) s.emit('groupKick');
      this.remove(target, false);
    });
    socket.on('pub', () => this.leaderSetting(m, 'isPrivate', false));
    socket.on('pug', () => this.leaderSetting(m, 'isPrivate', true));
    socket.on('swapTeams', () => {
      if (!m.leader) return;
      for (const o of this.members.values()) if (o.team === TEAM.RED || o.team === TEAM.BLUE) { o.team = o.team === TEAM.RED ? TEAM.BLUE : TEAM.RED; this.broadcastMember(o); }
    });
    socket.on('randomTeams', () => {
      if (!m.leader) return;
      const pool = this.memberList().filter((o) => o.team === TEAM.RED || o.team === TEAM.BLUE);
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      pool.forEach((o, i) => { o.team = i % 2 === 0 ? TEAM.RED : TEAM.BLUE; this.broadcastMember(o); });
    });
    socket.on('groupPlay', () => { if (m.leader && gamesApi) gamesApi.launchGroupGame(this); });
    socket.on('endGame', () => { if (m.leader && gamesApi && this.game.gameId) gamesApi.endGame(this.game.gameId); });
    socket.on('groupPresetGenerate', () => socket.emit('groupPreset', this.preset()));
    socket.on('groupPresetApply', (p) => socket.emit('groupPresetResult', m.leader && this.applyPreset(p)));
    socket.on('applyPersonalMute', (d) => { if (d && this.members.has(d.playerId)) { m.mutedGroupIds[d.playerId] = true; this.broadcastMember(m); } });
    socket.on('removePersonalMute', (d) => { if (d && this.members.has(d.playerId)) { m.mutedGroupIds[d.playerId] = false; this.broadcastMember(m); } });
    socket.on('disconnect', () => {
      m.sockets.delete(socket);
      if (m.sockets.size === 0 && this.members.get(m.id) === m) {
        m.leaveTimer = setTimeout(() => this.remove(m, true), LEAVE_GRACE_MS);
      }
    });
  }

  leaderSetting(m, name, value) {
    if (!m.leader || this.settings[name] === value) return;
    this.settings[name] = value;
    if (name === 'isPrivate') for (const o of this.members.values()) { o.team = this.defaultTeam(o.leader); this.broadcastMember(o); }
    this.broadcastSetting(name);
  }

  remove(m, announce) {
    if (this.members.get(m.id) !== m) return;
    clearTimeout(m.leaveTimer);
    this.members.delete(m.id);
    if (m.session.groupId === this.id) m.session.groupId = null;
    this.nsp.emit('removed', { id: m.id });
    for (const s of m.sockets) s.disconnect();
    if (announce !== false) this.systemChat(`${m.name} has left the group.`);
    if (m.leader) {
      const next = this.members.values().next().value;
      if (next) { next.leader = true; this.broadcastMember(next); this.systemChat(`${next.name} is now the leader.`); }
    }
    if (this.members.size === 0) groups.delete(this.id);
  }

  setGame(gameId) {
    this.game = { gameServer: gameId ? 'local' : null, gameId: gameId || null };
    this.nsp.emit('game', this.game);
  }

  // Official TagPro preset format (see preset.js).
  preset() { return presets.encode(this.settings, this.modeMap); }

  applyPreset(p) {
    const parsed = presets.parse(p);
    if (!parsed) return false;
    const { changed, modeMap } = presets.apply(this.settings, parsed);
    this.modeMap = modeMap;
    if (changed.includes('map') && String(this.settings.map).startsWith('fm_id/')) {
      this.settings.mapId = String(this.settings.map).slice(6);
      changed.push('mapId');
    }
    if (this.nsp) for (const name of changed) this.broadcastSetting(name);
    return true;
  }
}

function attach(io, api) {
  gamesApi = api;
  io.of(/^\/groups\/[a-z]{8}$/).on('connection', (socket) => {
    const g = groups.get(socket.nsp.name.slice(8));
    const session = sessions.fromSocket(socket);
    if (!g || !session) { socket.emit('groupKick'); return socket.disconnect(); }
    if (!g.nsp) g.nsp = socket.nsp;
    g.join(socket, session);
  });
}

function leave(session) {
  const g = session.groupId && groups.get(session.groupId);
  const m = g && g.members.get(session.id);
  if (m) g.remove(m, true);
}

module.exports = { Group, groups, attach, leave, TEAM };
