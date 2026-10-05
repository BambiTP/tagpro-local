// queue.js - public matchmaking for "Play Now": players wait in the joiner until 8 are queued,
// then a public game starts with 4 on each team. Uses the real joiner messages: "Full" with
// `considering` shows "Looking for a game", serverStatsUpdated shows "playing | queued" counts.
const admin = require('./admin');
const GAME_SIZE = () => admin.gameSize();

const queue = []; // { session, socket }
let gamesApi = null; // { createGame, resolveMap, games }

function counts() {
  const live = [...gamesApi.games.values()].filter((r) => !r.closed && !r.ended);
  const playing = live.reduce((n, r) => n + r.playerCount(), 0);
  return { queued: queue.length, needed: GAME_SIZE(), playing, games: live.length };
}

// the joiner page shows these next to every region checkbox as "<playing> | <queued>"
function statsPacket() {
  const c = counts();
  const region = { ingame: c.playing, casualMatchmaking: c.queued, inrankedgame: 0, rankedMatchmaking: 0 };
  return { when: new Date().toISOString(), TOTAL: { ...region, games: c.games, online: c.playing + c.queued }, NAE: region, NAC: region, NAW: region, EU: region, OC: region };
}

function broadcast() {
  const stats = statsPacket();
  for (const q of queue) {
    q.socket.emit('Full', { considering: ['Local'], consideringForRanked: [], readyForGame: false, attemptedRankedSize: 0, groupMembers: [] });
    q.socket.emit('serverStatsUpdated', stats);
  }
}

async function tryStart() {
  while (queue.length >= GAME_SIZE()) {
    const batch = queue.splice(0, GAME_SIZE());
    // the admin panel refuses maps with no valid spawns; if one still gets picked, try another
    let room = null;
    for (let i = 0; !room && i < 5; i++) {
      const mapKey = await gamesApi.resolveMap(i ? 'random' : admin.mapChoice(), admin.rotationPool());
      try { room = gamesApi.createGame({ mapKey, settings: admin.publicSettings(), isPrivate: false, groupId: null }); } catch (e) { console.error('Play Now:', e.message); }
    }
    if (!room) { queue.unshift(...batch); break; }
    room.fixedTeams = true;
    room.countsForStats = true; // Play Now games feed profile stats and degrees
    batch.forEach((q, i) => {
      q.session.pendingGame = { id: room.id, team: i % 2 === 0 ? 1 : 2, spectate: false };
      q.socket.emit('FoundWorld', { url: '/game', spectate: null });
    });
  }
  broadcast();
}

function join(session, socket) {
  if (queue.some((q) => q.session === session)) return;
  queue.push({ session, socket });
  socket.on('disconnect', () => leave(socket));
  socket.on('leaveJoiner', () => leave(socket));
  tryStart();
}

function leave(socket) {
  const i = queue.findIndex((q) => q.socket === socket);
  if (i >= 0) { queue.splice(i, 1); broadcast(); }
}

module.exports = { join, counts, statsPacket, init: (api) => { gamesApi = api; } };
