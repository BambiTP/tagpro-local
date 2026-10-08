// ranked.js - Eggball Ranked: a logged-in-only queue next to Play Now's casual one. When 12 are queued
// an eggball game starts 6v6 with teams balanced by rating; afterwards everyone's Elo rating moves
// (start 1500). If a player leaves, the game is voided unless 4 of their 5 teammates double-tap Shift
// within 30 seconds to keep playing; either way the leaver takes a loss and a ranked queue lockout.
const admin = require('./admin');
const accounts = require('./accounts');
const { address, PER_ADDRESS } = require('./queue');

const GAME_SIZE = Number(process.env.RANKED_SIZE) || 12; // tests use a smaller game
const K = 32;
const VOTE_MS = 30000;
const VOTE_SHARE = 4 / 5;           // 4 of 5 remaining teammates
const BAN_MS = 15 * 60 * 1000;      // first leave in a day; each further leave that day doubles it
const BAN_MAX_MS = 24 * 60 * 60 * 1000;

const queue = []; // { session, socket }
let gamesApi = null; // { createGame, resolveMap, games }

const expected = (mine, theirs) => 1 / (1 + Math.pow(10, (theirs - mine) / 400));
const minutes = (ms) => { const m = Math.ceil(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

function liveRooms() { return [...gamesApi.games.values()].filter((r) => r.ranked && !r.closed && !r.ended); }
function counts() {
  const live = liveRooms();
  return { queued: queue.length, needed: GAME_SIZE, playing: live.reduce((n, r) => n + r.playerCount(), 0), games: live.length };
}

function broadcast() {
  for (const q of queue) q.socket.emit('Full', { considering: ['Local'], consideringForRanked: [], readyForGame: false, attemptedRankedSize: 0, groupMembers: [] });
}

// strongest to weakest, dealt red, blue, blue, red, red, blue, ... so the averages come out close
function splitTeams(batch) {
  const sorted = batch.slice().sort((a, b) => accounts.rankedOf(b.session.account).rating - accounts.rankedOf(a.session.account).rating);
  return sorted.map((q, i) => ({ q, team: [1, 2, 2, 1][i % 4] }));
}

async function tryStart() {
  while (queue.length >= GAME_SIZE) {
    const batch = queue.splice(0, GAME_SIZE);
    let room = null;
    try {
      const mapKey = await gamesApi.resolveMap('eggball');
      room = gamesApi.createGame({ mapKey, settings: { ...admin.publicSettings(), mode: 'eggball', mercyRule: 10, eggballLosingTeamStarts: true, mapTestingMode: false }, isPrivate: false, groupId: null });
    } catch (e) { console.error('Eggball Ranked:', e.message); }
    if (!room) { queue.unshift(...batch); break; }
    room.fixedTeams = true;
    const roster = new Map(); // accountId -> { team, name, rating (at the start), present }
    for (const { q, team } of splitTeams(batch)) {
      const a = q.session.account;
      roster.set(a.id, { team, name: a.displayName, rating: accounts.rankedOf(a).rating, present: true });
      q.session.pendingGame = { id: room.id, team, spectate: false };
      q.socket.emit('FoundWorld', { url: '/game', spectate: null });
    }
    room.ranked = { roster, votes: { 1: null, 2: null }, voided: false };
    room.onPlayerJoined = (p) => joined(room, p);
    room.onPlayerLeft = (p) => left(room, p);
    room.onRankedContinue = (p) => vote(room, p);
  }
  broadcast();
}

function join(session, socket) {
  const a = session.account;
  if (!a) return socket.emit('SendToPage', { url: '/login', reason: 'Log in to play Eggball Ranked' });
  const wait = (accounts.rankedOf(a).bannedUntil || 0) - Date.now();
  if (wait > 0) return socket.emit('NotRankedEligible', { timeLeft: minutes(wait) + ' (you left a ranked game)' });
  const i = queue.findIndex((q) => q.session.account && q.session.account.id === a.id);
  if (i >= 0) { if (queue[i].socket === socket) return; queue.splice(i, 1); } // a second tab replaces the first
  if (queue.filter((q) => address(q.socket) === address(socket)).length >= PER_ADDRESS) {
    return socket.emit('SendToPage', { url: '/', reason: 'Too many players from your network are already in the queue' });
  }
  queue.push({ session, socket });
  socket.on('disconnect', () => leave(socket));
  socket.on('leaveJoiner', () => leave(socket));
  tryStart();
}

function leave(socket) {
  const i = queue.findIndex((q) => q.socket === socket);
  if (i >= 0) { queue.splice(i, 1); broadcast(); }
}

// ---- in game ----
const say = (room, message) => room.broadcast('chat', { from: null, message, to: 'all', c: '#ffcc33' });
const teamName = (t) => (t === 1 ? 'Red' : 'Blue');
const presentOn = (room, team) => [...room.ranked.roster.values()].filter((m) => m.team === team && m.present).length;

function joined(room, p) {
  const m = room.ranked.roster.get(p.accountId);
  room.send(p.client, 'chat', { from: null, message: 'Eggball Ranked: if a player leaves, the game is voided unless 4 of their 5 teammates double-tap Shift within 30 seconds to keep playing. Leavers lose rating and are locked out of ranked for a while.', to: p.id, c: '#ffcc33' });
  if (!m || m.present) return;
  m.present = true;
  const v = room.ranked.votes[m.team];
  if (v && v.missing.delete(p.accountId) && !v.missing.size) {
    clearTimeout(v.timer);
    room.ranked.votes[m.team] = null;
    say(room, `${m.name} is back. No vote needed.`);
  }
}

function left(room, p) {
  const r = room.ranked;
  const m = r.roster.get(p.accountId);
  if (!m || room.ended || r.voided) return;
  m.present = false;
  const team = m.team;
  const v = r.votes[team];
  if (v) { v.missing.add(p.accountId); v.yes.delete(p.accountId); }
  else r.votes[team] = { missing: new Set([p.accountId]), yes: new Set(), timer: room.later(VOTE_MS, () => voteTimeout(room, team)) };
  const need = Math.ceil(presentOn(room, team) * VOTE_SHARE);
  say(room, `${m.name} left. ${teamName(team)} team: double-tap Shift to keep playing (${need} of ${presentOn(room, team)} needed, 30 seconds), or the game is voided.`);
  checkVote(room, team);
}

function vote(room, p) {
  const r = room.ranked;
  const m = r && r.roster.get(p.accountId);
  const v = m && r.votes[m.team];
  if (!v || !m.present || v.yes.has(p.accountId)) return;
  v.yes.add(p.accountId);
  checkVote(room, m.team, m.name);
}

function checkVote(room, team, voter) {
  const v = room.ranked.votes[team];
  if (!v) return;
  const present = presentOn(room, team), need = Math.ceil(present * VOTE_SHARE);
  if (present && v.yes.size >= need) {
    clearTimeout(v.timer);
    room.ranked.votes[team] = null;
    say(room, `${teamName(team)} voted to keep playing. The game still counts; the leaver takes a loss.`);
  } else if (voter) say(room, `${voter} voted to keep playing (${v.yes.size} of ${need}).`);
}

function voteTimeout(room, team) {
  if (room.ended || !room.ranked.votes[team]) return;
  room.ranked.votes[team] = null;
  voidGame(room, `${teamName(team)} didn't vote to keep playing.`);
}

function voidGame(room, why) {
  const r = room.ranked;
  if (r.voided) return;
  r.voided = true;
  penalizeLeavers(room);
  say(room, `${why} The game is voided: no ratings change, except the leaver's.`);
  if (!room.ended) room.end('tie', false);
}

// a leaver loses rating as if their team lost, and can't queue for a while
function penalizeLeavers(room) {
  const r = room.ranked;
  const avg = (team) => { const ms = [...r.roster.values()].filter((m) => m.team === team); return ms.reduce((n, m) => n + m.rating, 0) / ms.length; };
  for (const [id, m] of r.roster) {
    if (m.present || m.penalized) continue;
    m.penalized = true;
    accounts.updateRanked(id, (st) => {
      st.rating = Math.round(st.rating - K * expected(m.rating, avg(m.team === 1 ? 2 : 1)));
      st.games++; st.losses++; st.leaves++;
      const day = Date.now() - 24 * 60 * 60 * 1000;
      st.leaveTimes = (st.leaveTimes || []).filter((t) => t > day).concat(Date.now());
      st.bannedUntil = Date.now() + Math.min(BAN_MAX_MS, BAN_MS * Math.pow(2, st.leaveTimes.length - 1));
    });
  }
}

// called once when the game ends (games.js)
function finish(room, winner) {
  const r = room.ranked;
  if (r.voided) return;
  if (r.votes[1] || r.votes[2]) return voidGame(room, 'The game ended during a leave vote.');
  penalizeLeavers(room);
  const ms = [...r.roster.values()];
  const avg = (team) => { const t = ms.filter((m) => m.team === team); return t.reduce((n, m) => n + m.rating, 0) / t.length; };
  const avgs = { 1: avg(1), 2: avg(2) };
  const winTeam = winner === 'red' ? 1 : winner === 'blue' ? 2 : 0;
  for (const [id, m] of r.roster) {
    if (!m.present) continue; // already penalized
    const score = winTeam === 0 ? 0.5 : winTeam === m.team ? 1 : 0;
    const delta = Math.round(K * (score - expected(avgs[m.team], avgs[m.team === 1 ? 2 : 1])));
    let now = null;
    accounts.updateRanked(id, (st) => {
      st.rating += delta; st.games++;
      if (score === 1) st.wins++; else if (score === 0) st.losses++; else st.ties++;
      now = st.rating;
    });
    const p = Object.values(room.players).find((x) => x.accountId === id);
    if (p && p.client) room.send(p.client, 'chat', { from: null, message: `Eggball rating: ${now - delta} -> ${now} (${delta >= 0 ? '+' : ''}${delta})`, to: p.id, c: '#ffcc33' });
  }
}

module.exports = { join, counts, finish, splitTeams, init: (api) => { gamesApi = api; } };
