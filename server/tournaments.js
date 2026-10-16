// tournaments.js - the Competitive tab: tournaments run by the organizer (only the "Bambi" account).
// Teams come from a draft (snake, straight order or auction) of the players who signed up, or are
// entered by the organizer. Brackets: single elimination, double elimination, or round robin with
// optional playoffs (server/bracket.js). When both captains of a match click Ready (or the
// organizer starts it), the server makes a private game, records the score when it ends and moves
// the bracket on. Saved in data/tournaments.json; the tournament page updates live over
// socket.io (namespace /competitive). Tournament games don't change Eggball Ranked ratings.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./accounts');
const admin = require('./admin');
const sessions = require('./sessions');
const B = require('./bracket');

const ORGANIZER = 'bambi'; // username (any capitalization)
const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'tournaments.json');
const EMPTY_GAME_MS = 3 * 60 * 1000; // a tournament game nobody joined is cancelled after this

const isOrganizer = (session) => !!(session && session.account && session.account.username.toLowerCase() === ORGANIZER);

// ---- storage ----
const tournaments = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } })(); // id -> tournament
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(tournaments));
  fs.renameSync(FILE + '.tmp', FILE);
}
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 200); };
process.on('exit', () => { if (saveTimer) flush(); });

let gamesApi = null; // { createGame, resolveMap, games }
let nsp = null;      // socket.io namespace
const timers = {};   // tournament id -> draft timer

// ---- helpers ----
const acct = (id) => accounts.byId(id);
const nameOf = (id) => { const a = acct(id); return a ? a.displayName : '(deleted)'; };
const ratingOf = (id) => accounts.rankedOf(acct(id)).rating;
const teamById = (t, id) => t.teams.find((x) => x.id === id);
const teamOf = (t, accountId) => t.teams.find((x) => x.players.includes(accountId));
const matchById = (t, id) => t.matches.find((m) => m.id === id);
const fail = (msg) => { const e = new Error(msg); e.user = true; throw e; };
const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
// teamCount 0: as many full teams as the sign ups make (fixed when the draft starts)
const teamsWanted = (t) => t.teamCount || Math.min(32, Math.floor(t.signups.length / t.teamSize));
const pick = (v, list, def) => (list.includes(v) ? v : def);

// ---- create ----
// form: name, format, playoffTeams, teamMode, draftType, teamCount, teamSize, budget, pickSeconds,
// bidSeconds, mode, map, time, caps, mercyRule, bestOf, finalBestOf, premade ("Team: a, b, c" lines)
function create(form) {
  const name = String(form.name || '').trim().slice(0, 60);
  if (!name) fail('Give the tournament a name.');
  const t = {
    id: crypto.randomBytes(5).toString('hex'), name, created: Date.now(), status: 'signup',
    format: pick(form.format, ['single', 'double', 'roundrobin'], 'single'),
    playoffTeams: int(form.playoffTeams, 0, 16, 4),
    teamMode: pick(form.teamMode, ['draft', 'premade'], 'draft'),
    draftType: pick(form.draftType, ['snake', 'straight', 'auction'], 'snake'),
    teamCount: form.teamsFrom === 'signups' ? 0 : int(form.teamCount, 2, 32, 4), teamSize: int(form.teamSize, 1, 8, 4),
    budget: int(form.budget, 1, 10000, 100), pickSeconds: int(form.pickSeconds, 10, 600, 45), bidSeconds: int(form.bidSeconds, 5, 120, 12),
    game: {
      mode: pick(form.mode, ['classic', 'eggball'], 'classic'), map: String(form.map || 'random').slice(0, 80),
      time: int(form.time, 1, 60, 10), caps: int(form.caps, 0, 50, 0), mercyRule: int(form.mercyRule, 0, 50, 0),
      bestOf: pick(int(form.bestOf, 1, 7, 1), [1, 3, 5, 7], 1), finalBestOf: pick(int(form.finalBestOf, 1, 7, 1), [1, 3, 5, 7], 1),
    },
    signups: [], captains: [], teams: [], draft: null, matches: [], champion: null,
  };
  if (t.format === 'roundrobin' && t.playoffTeams === 1) t.playoffTeams = 0;
  if (t.teamMode === 'premade') {
    t.teams = parsePremade(String(form.premade || ''), t.teamSize);
    if (t.teams.length < 2) fail('Enter at least two teams, one per line.');
    t.teamCount = t.teams.length;
    t.status = 'ready';
  } else if (t.draftType === 'auction' && t.budget < t.teamSize) fail('The auction budget must be at least the team size (every pick costs at least 1).');
  tournaments[t.id] = t;
  save();
  return t;
}

// "Team name: player, player, ..." per line; players are usernames; the first one is captain
function parsePremade(text, teamSize) {
  const teams = [], seen = new Set();
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(':');
    if (i < 1) fail(`"${line.slice(0, 40)}": write it as "Team name: player, player, ..."`);
    const name = line.slice(0, i).trim().slice(0, 30);
    const players = line.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean).map((u) => {
      const a = accounts.byUsername(u);
      if (!a) fail(`No account named "${u.slice(0, 20)}".`);
      if (seen.has(a.id)) fail(`${a.username} is on two teams.`);
      seen.add(a.id);
      return a.id;
    });
    if (!players.length) fail(`${name} has no players.`);
    if (players.length > teamSize) fail(`${name} has ${players.length} players; teams are ${teamSize}.`);
    teams.push({ id: 't' + teams.length, name, captain: players[0], players });
  }
  return teams;
}

// ---- sign ups ----
function signup(t, session) {
  if (!session.account) fail('Log in to sign up.');
  if (t.status !== 'signup') fail('Sign ups are closed.');
  if (!t.signups.includes(session.account.id)) t.signups.push(session.account.id);
}
function withdraw(t, accountId) {
  if (t.status !== 'signup') fail('Sign ups are closed.');
  t.signups = t.signups.filter((x) => x !== accountId);
  t.captains = t.captains.filter((x) => x !== accountId);
}
function setCaptains(t, ids) {
  if (t.status !== 'signup') fail('Sign ups are closed.');
  ids = [...new Set((ids || []).map(String))].filter((x) => t.signups.includes(x));
  if (ids.length > Math.max(teamsWanted(t), 2)) fail(`Pick at most ${Math.max(teamsWanted(t), 2)} captains.`);
  t.captains = ids;
}
// the highest Eggball Ranked ratings captain
function autoCaptains(t) {
  if (t.status !== 'signup') fail('Sign ups are closed.');
  t.captains = t.signups.slice().sort((a, b) => ratingOf(b) - ratingOf(a)).slice(0, teamsWanted(t));
}

// ---- draft ----
// captains make the teams; the lowest-rated captain picks (or nominates) first
function startDraft(t) {
  if (t.status !== 'signup') fail('The draft has already started.');
  const count = teamsWanted(t);
  if (count < 2) fail(`Need at least ${2 * t.teamSize} sign ups for two teams of ${t.teamSize} (${t.signups.length} so far).`);
  if (t.captains.length !== count) fail(`Choose ${count} captains first (${t.captains.length} chosen).`);
  const need = count * t.teamSize;
  if (t.signups.length < need) fail(`Need ${need} sign ups for ${count} teams of ${t.teamSize} (${t.signups.length} so far).`);
  t.teamCount = count;
  const caps = t.captains.slice().sort((a, b) => ratingOf(a) - ratingOf(b));
  t.teams = caps.map((c, i) => ({ id: 't' + i, name: 'Team ' + nameOf(c), captain: c, players: [c] }));
  t.status = 'draft';
  if (t.draftType === 'auction') {
    t.draft = { type: 'auction', budgets: Object.fromEntries(t.teams.map((x) => [x.id, t.budget])), turn: 0, lot: null, deadline: Date.now() + t.pickSeconds * 1000, log: [] };
  } else {
    const order = pickOrder(t.teams.map((x) => x.id), t.teamSize - 1, t.draftType);
    t.draft = { type: t.draftType, order, pick: 0, deadline: Date.now() + t.pickSeconds * 1000, log: [] };
  }
  if (t.teamSize === 1) return endDraft(t);
  armDraft(t);
}

// snake: 1-2-3-4, 4-3-2-1, ...; straight: 1-2-3-4 every round
function pickOrder(teamIds, rounds, type) {
  const order = [];
  for (let r = 0; r < rounds; r++) order.push(...(type === 'snake' && r % 2 ? teamIds.slice().reverse() : teamIds));
  return order;
}

const available = (t) => t.signups.filter((id) => !teamOf(t, id));
const bestAvailable = (t) => available(t).sort((a, b) => ratingOf(b) - ratingOf(a))[0];
const openSlots = (t, team) => t.teamSize - team.players.length;
// auction: keep 1 per slot still to fill after this one
const maxBid = (t, team) => t.draft.budgets[team.id] - (openSlots(t, team) - 1);
const onClock = (t) => {
  const d = t.draft;
  if (!d) return null;
  if (d.type === 'auction') return d.lot ? null : t.teams[d.turn];
  return teamById(t, d.order[d.pick]);
};
// a captain acts for their team; the organizer can act for whoever is on the clock
function actingTeam(t, session, team) {
  if (!session.account) fail('Log in first.');
  if (team && (team.captain === session.account.id || isOrganizer(session))) return team;
  fail("It's not your turn.");
}

function draftPick(t, session, playerId) {
  const d = t.draft;
  if (t.status !== 'draft' || d.type === 'auction') fail('Not a pick draft.');
  const team = actingTeam(t, session, onClock(t));
  if (!available(t).includes(playerId)) fail("That player isn't available.");
  team.players.push(playerId);
  d.log.push({ team: team.id, player: playerId, auto: !!session.auto });
  d.pick++;
  if (d.pick >= d.order.length) return endDraft(t);
  d.deadline = Date.now() + t.pickSeconds * 1000;
  armDraft(t);
}

function nominate(t, session, playerId, bid) {
  const d = t.draft;
  if (t.status !== 'draft' || d.type !== 'auction' || d.lot) fail('Not your turn to nominate.');
  const team = actingTeam(t, session, onClock(t));
  if (!available(t).includes(playerId)) fail("That player isn't available.");
  bid = int(bid, 1, 1e6, 1);
  if (bid > maxBid(t, team)) fail(`You can bid at most ${maxBid(t, team)} (you must keep 1 for each other open spot).`);
  // nobody else has room: the player just joins this team
  if (!t.teams.some((x) => x !== team && openSlots(t, x) > 0)) return award(t, team, playerId, 0);
  d.lot = { player: playerId, bid, bidder: team.id, deadline: Date.now() + t.bidSeconds * 1000 };
  armDraft(t);
}

function bid(t, session, amount) {
  const d = t.draft;
  if (t.status !== 'draft' || d.type !== 'auction' || !d.lot) fail('Nothing is up for auction.');
  if (!session.account) fail('Log in first.');
  const team = t.teams.find((x) => x.captain === session.account.id);
  if (!team) fail('Only captains bid.');
  if (team.id === d.lot.bidder) fail('You already have the top bid.');
  if (openSlots(t, team) < 1) fail('Your team is full.');
  amount = int(amount, 1, 1e6, 0);
  if (amount <= d.lot.bid) fail(`Bid more than ${d.lot.bid}.`);
  if (amount > maxBid(t, team)) fail(`You can bid at most ${maxBid(t, team)} (you must keep 1 for each other open spot).`);
  d.lot.bid = amount; d.lot.bidder = team.id;
  d.lot.deadline = Math.max(d.lot.deadline, Date.now() + Math.min(t.bidSeconds, 8) * 1000); // a late bid gives others time to answer
  armDraft(t);
}

function award(t, team, playerId, price) {
  const d = t.draft;
  team.players.push(playerId);
  d.budgets[team.id] -= price;
  d.log.push({ team: team.id, player: playerId, price });
  d.lot = null;
  if (t.teams.every((x) => openSlots(t, x) === 0)) return endDraft(t);
  // next team with room nominates
  do { d.turn = (d.turn + 1) % t.teams.length; } while (openSlots(t, t.teams[d.turn]) === 0);
  d.deadline = Date.now() + t.pickSeconds * 1000;
  armDraft(t);
}

// timers: a pick or nomination that runs out takes the highest-rated player left; an auction
// that runs out goes to the top bid
function armDraft(t) {
  clearTimeout(timers[t.id]);
  if (t.status !== 'draft') return;
  const d = t.draft, at = d.lot ? d.lot.deadline : d.deadline;
  timers[t.id] = setTimeout(() => {
    try {
      const asCaptain = (team) => ({ account: { id: team.captain, username: '' }, auto: true });
      if (d.type !== 'auction') draftPick(t, asCaptain(onClock(t)), bestAvailable(t));
      else if (d.lot) award(t, teamById(t, d.lot.bidder), d.lot.player, d.lot.bid);
      else nominate(t, asCaptain(onClock(t)), bestAvailable(t), 1);
    } catch (e) { console.error('draft timer', t.id, e.message); }
    changed(t);
  }, Math.max(0, at - Date.now()));
}

// seeds: best average Eggball Ranked rating first
function endDraft(t) {
  clearTimeout(timers[t.id]);
  t.draft.done = true;
  const avg = (x) => x.players.reduce((n, id) => n + ratingOf(id), 0) / x.players.length;
  t.teams.sort((a, b) => avg(b) - avg(a));
  t.status = 'ready';
  startTournament(t);
}

// ---- bracket ----
function startTournament(t) {
  if (t.status !== 'ready') fail(t.status === 'signup' ? 'Run the draft first.' : 'Already started.');
  if (t.teams.length < 2) fail('Need at least two teams.');
  const ids = t.teams.map((x) => x.id);
  t.matches = t.format === 'single' ? B.singleElim(ids) : t.format === 'double' ? B.doubleElim(ids) : B.roundRobin(ids);
  if (t.format === 'roundrobin' && t.playoffTeams > ids.length) t.playoffTeams = ids.length;
  t.status = 'playing';
  advance(t);
}

const isFinal = (t, m) => m.label === 'Final' || m.bracket === 'GF';
const bestOfFor = (t, m) => (isFinal(t, m) ? t.game.finalBestOf : t.game.bestOf);

// after any result: fill the bracket, add playoffs / a grand final reset, crown a champion
function advance(t) {
  B.resolve(t.matches);
  if (t.format === 'roundrobin' && t.playoffTeams >= 2 && !t.matches.some((m) => m.bracket === 'P')
    && t.matches.filter((m) => m.bracket === 'RR').every((m) => m.done)) {
    const top = B.standings(t.matches, t.teams.map((x) => x.id)).slice(0, t.playoffTeams).map((r) => r.team);
    t.matches.push(...B.singleElim(top, 'P'));
    B.resolve(t.matches);
  }
  const champ = B.champion(t.matches, t.format, t.teams.map((x) => x.id), t.format === 'roundrobin' ? t.playoffTeams : 0);
  if (champ) { t.champion = champ; t.status = 'done'; }
}

// a captain says their team is here; when both are, the game starts
function ready(t, session, matchId, on) {
  const m = matchById(t, matchId);
  if (t.status !== 'playing' || !m || !B.playable(m)) fail("That match can't be played yet.");
  if (m.live) fail('The game is already running.');
  const mine = session.account && [m.a, m.b].map((id) => teamById(t, id)).find((x) => x.captain === session.account.id);
  if (!mine) fail('Only the two captains mark their team ready.');
  m.ready = (m.ready || []).filter((x) => x !== mine.id);
  if (on) m.ready.push(mine.id);
  if (m.ready.length === 2) return startGame(t, m);
}

async function startGame(t, m) {
  if (m.live || m.starting) return;
  m.starting = true;
  try {
    const g = t.game, n = m.games.length;
    const red = n % 2 === 0 ? 'a' : 'b', blue = red === 'a' ? 'b' : 'a'; // sides swap colours each game
    const mapKey = await gamesApi.resolveMap(g.mode === 'eggball' ? 'eggball' : g.map);
    const settings = Object.assign({}, admin.publicSettings(), {
      time: g.time, caps: g.caps, mercyRule: g.mercyRule, mapTestingMode: false, disableAfk: true,
      maxPlayersPerTeam: Math.max(4, t.teamSize), redTeamName: teamById(t, m[red]).name.slice(0, 30), blueTeamName: teamById(t, m[blue]).name.slice(0, 30),
    }, g.mode === 'eggball' ? { mode: 'eggball', eggballLosingTeamStarts: true } : {});
    const room = gamesApi.createGame({ mapKey, settings, isPrivate: true, groupId: null });
    room.fixedTeams = true;
    room.tournament = { tid: t.id, matchId: m.id, red, blue };
    m.live = { gameId: room.id, red, map: room.mapName, started: Date.now() };
    m.ready = [];
    const check = () => {
      if (room.ended || !m.live || m.live.gameId !== room.id) return;
      if (room.playerCount() === 0) cancelGame(t, m, 'Nobody joined the game.');
    };
    setTimeout(check, EMPTY_GAME_MS).unref();
  } catch (e) {
    console.error('tournament game', t.id, m.id, e.message);
    m.error = "Couldn't start the game: " + e.message;
  } finally { m.starting = false; changed(t); }
}

// the organizer stops a running game; it doesn't count
function cancelGame(t, m, why) {
  if (!m.live) fail('No game is running.');
  const room = gamesApi.games.get(m.live.gameId);
  m.note = why || 'The organizer cancelled the last game.';
  m.live = null;
  if (room && !room.ended) { room.tournament.cancelled = true; room.end('tie', false); }
  changed(t);
}

// called once when a tournament game ends (games.js)
function finish(room, winner) {
  const info = room.tournament, t = tournaments[info.tid], m = t && matchById(t, info.matchId);
  if (!m || info.cancelled || !m.live || m.live.gameId !== room.id || m.done) return;
  const score = { [info.red]: room.score.r, [info.blue]: room.score.b };
  const side = winner === 'red' ? info.red : winner === 'blue' ? info.blue : 'tie';
  m.live = null; m.note = null;
  const replay = room.recorder ? Buffer.from(room.recorder.id, 'hex').toString('base64').replace(/\+/g, '_') : null;
  B.recordGame(m, { gameId: room.id, replay, red: info.red, map: room.mapName, score, winner: side }, bestOfFor(t, m), m.bracket === 'RR');
  if (!m.done && side === 'tie' && m.bracket !== 'RR') m.note = 'Tied: that game is replayed.';
  advance(t);
  changed(t);
}

// the organizer decides a match (no-show, forfeit)
function decide(t, m, side) {
  if (m.done || !B.playable(m)) fail("That match isn't open.");
  if (m.live) cancelGame(t, m, 'Decided by the organizer.');
  m.done = true; m.forfeit = true;
  m.winner = m[side]; m.loser = m[side === 'a' ? 'b' : 'a'];
  advance(t);
}

// ---- views ----
function view(t) {
  const person = (id) => ({ id, name: nameOf(id), rating: ratingOf(id) });
  const d = t.draft;
  return {
    id: t.id, name: t.name, status: t.status, format: t.format, playoffTeams: t.playoffTeams, teamMode: t.teamMode, draftType: t.draftType,
    teamCount: t.teamCount, teamsWanted: teamsWanted(t), teamSize: t.teamSize, budget: t.budget, pickSeconds: t.pickSeconds, bidSeconds: t.bidSeconds, game: t.game,
    signups: t.signups.map(person), captains: t.captains,
    teams: t.teams.map((x) => ({ id: x.id, name: x.name, captain: x.captain, players: x.players.map(person) })),
    draft: d && {
      type: d.type, done: !!d.done, log: d.log, onClock: onClock(t) && onClock(t).id,
      pick: d.pick, total: d.order && d.order.length, order: d.order,
      budgets: d.budgets, lot: d.lot, maxBids: d.budgets && Object.fromEntries(t.teams.map((x) => [x.id, openSlots(t, x) ? maxBid(t, x) : 0])),
      deadline: d.lot ? d.lot.deadline : d.deadline,
    },
    matches: t.matches.map((m) => ({
      id: m.id, bracket: m.bracket, round: m.round, label: m.label, a: m.a, b: m.b, wins: m.wins, done: m.done, bye: !!m.bye,
      draw: !!m.draw, forfeit: !!m.forfeit, winner: m.winner, playable: B.playable(m), ready: m.ready || [], live: m.live || null,
      note: m.note || m.error || null, bestOf: bestOfFor(t, m), games: m.games,
    })),
    standings: t.format === 'roundrobin' && t.matches.length ? B.standings(t.matches, t.teams.map((x) => x.id)) : null,
    champion: t.champion, now: Date.now(),
  };
}
const list = () => Object.values(tournaments).sort((a, b) => b.created - a.created);
const get = (id) => (Object.hasOwn(tournaments, id) ? tournaments[id] : null);

function changed(t) {
  save();
  if (nsp && tournaments[t.id]) nsp.to('t:' + t.id).emit('state', view(t));
}

// ---- socket: /competitive ----
function attach(io) {
  nsp = io.of('/competitive');
  nsp.on('connection', (socket) => {
    const session = sessions.fromSocket(socket);
    if (!session) return socket.disconnect();
    let t = null;
    socket.on('watch', (id) => {
      t = get(String(id));
      if (!t) return socket.emit('gone');
      socket.join('t:' + t.id);
      socket.emit('me', { id: session.account ? session.account.id : null, organizer: isOrganizer(session) });
      socket.emit('state', view(t));
    });
    socket.on('act', (a, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!t || !a || typeof a !== 'object' || !tournaments[t.id]) return reply('No tournament.');
      try {
        act(t, session, a);
        if (tournaments[t.id]) changed(t); else nsp.to('t:' + t.id).emit('gone');
        reply(null);
      } catch (e) {
        if (!e.user) console.error('tournament action', a.type, e);
        reply(e.user ? e.message : 'Something went wrong.');
      }
    });
  });
}

function act(t, session, a) {
  const org = isOrganizer(session);
  const needOrg = () => { if (!org) fail('Only the organizer can do that.'); };
  const m = a.match ? matchById(t, String(a.match)) : null;
  switch (a.type) {
    case 'signup': return signup(t, session);
    case 'withdraw': if (!session.account) fail('Log in first.'); return withdraw(t, session.account.id);
    case 'remove': needOrg(); return withdraw(t, String(a.player));
    case 'captains': needOrg(); return setCaptains(t, Array.isArray(a.ids) ? a.ids : []);
    case 'autoCaptains': needOrg(); return autoCaptains(t);
    case 'startDraft': needOrg(); return startDraft(t);
    case 'pick': return draftPick(t, session, String(a.player));
    case 'nominate': return nominate(t, session, String(a.player), a.bid);
    case 'bid': return bid(t, session, a.amount);
    case 'start': needOrg(); return startTournament(t);
    case 'ready': return ready(t, session, String(a.match), !!a.on);
    case 'forceStart': needOrg(); if (!m || !B.playable(m) || m.live) fail("That match can't start."); return startGame(t, m);
    case 'cancelGame': needOrg(); if (!m) fail('No such match.'); return cancelGame(t, m);
    case 'award': needOrg(); if (!m) fail('No such match.'); return decide(t, m, a.side === 'b' ? 'b' : 'a');
    case 'delete': needOrg();
      clearTimeout(timers[t.id]);
      for (const x of t.matches) if (x.live) { const r = gamesApi.games.get(x.live.gameId); if (r && !r.ended) { r.tournament.cancelled = true; r.end('tie', false); } }
      delete tournaments[t.id];
      return save();
    default: fail('Unknown action.');
  }
}

// /competitive/<id>/play: send this player to their team's running game (or watch one)
function playTarget(t, session, matchId) {
  const live = t.matches.filter((m) => m.live && gamesApi.games.has(m.live.gameId) && !gamesApi.games.get(m.live.gameId).ended);
  const team = session.account && teamOf(t, session.account.id);
  const mine = team && live.find((m) => m.a === team.id || m.b === team.id);
  if (mine && (!matchId || matchId === mine.id)) {
    const side = mine.a === team.id ? 'a' : 'b';
    return { id: mine.live.gameId, team: mine.live.red === side ? 1 : 2, spectate: false };
  }
  const watch = live.find((m) => m.id === matchId) || (!matchId && live[0]);
  return watch ? { id: watch.live.gameId, team: null, spectate: true } : null;
}

// after a restart: running games are gone and draft timers need re-arming
function init(api) {
  gamesApi = api;
  for (const t of Object.values(tournaments)) {
    for (const m of t.matches) { if (m.live) m.note = 'The server restarted during this game; it is replayed.'; m.live = null; m.starting = false; m.ready = []; }
    if (t.status === 'draft') {
      const d = t.draft;
      if (d.lot) d.lot.deadline = Math.max(d.lot.deadline, Date.now() + t.bidSeconds * 1000);
      else d.deadline = Math.max(d.deadline, Date.now() + t.pickSeconds * 1000);
      armDraft(t);
    }
  }
}

module.exports = { init, attach, create, list, get, view, finish, playTarget, isOrganizer, pickOrder, ORGANIZER };
