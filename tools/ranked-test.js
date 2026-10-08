// ranked-test.js - Eggball Ranked end to end: login required, queue -> 2v2 game (RANKED_SIZE=4),
// teams by rating, Elo after a normal end, the Shift vote after a leave, and voiding + leaver lockout.
// Runs the server in this process on a spare port, with throwaway accounts it deletes afterwards.
//   node tools/ranked-test.js
process.env.RANKED_SIZE = '4';
process.env.PORT = process.env.PORT || '3917';
process.env.HOST = '127.0.0.1';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
for (const f of ['accounts.json', 'logins.json']) if (fs.existsSync(path.join(DATA, f))) { console.error(`data/${f} exists: run this on a checkout without real accounts`); process.exit(1); }

require('../server/index');
const games = require('../server/games');
const accounts = require('../server/accounts');
const { io } = require('socket.io-client');
const base = 'http://127.0.0.1:' + process.env.PORT;

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await wait(50); } return null; };

async function register(name) {
  const r = await fetch(base + '/register', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `username=${name}&password=hunter22` });
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  return { name, cookie, id: accounts.search(name)[0].id };
}

// queue for ranked, then join the game it finds; returns { game socket, chat log, team }
async function queueAndPlay(u) {
  await fetch(base + '/games/find?type=ranked', { headers: { cookie: u.cookie } });
  const j = io(base + '/games/find', { extraHeaders: { cookie: u.cookie }, transports: ['websocket'], forceNew: true });
  const found = new Promise((r) => j.on('FoundWorld', r));
  j.on('connect', () => j.emit('JoinerSelections', {}));
  u.joiner = j; u.pid = null; u.gameId = null;
  u.found = found.then(async () => {
    const page = await (await fetch(base + '/game', { headers: { cookie: u.cookie } })).text();
    u.gameId = /\/game\/([a-z]{8})/.exec(page)[1];
    u.hasShift = page.includes('rankedContinue');
    u.chat = [];
    u.sock = io(base + '/game/' + u.gameId, { extraHeaders: { cookie: u.cookie }, transports: ['websocket'], forceNew: true });
    u.sock.on('chat', (c) => u.chat.push(c.message));
    u.sock.on('id', (id) => { u.pid = id; });
    j.disconnect();
  });
}
const room = (u) => games.games.get(u.gameId);
const teamOf = (u) => room(u).ranked.roster.get(u.id).team;
const said = (users, re) => users.some((u) => u.chat.some((m) => re.test(m)));

(async () => {
  // logged out: sent to the login page
  const anon = await fetch(base + '/games/find?type=ranked', { redirect: 'manual' });
  ok(anon.status === 302 && anon.headers.get('location') === '/login', 'ranked joiner needs a login');

  const u = [];
  for (let i = 0; i < 5; i++) u.push(await register('rt' + i + Math.floor(Math.random() * 1e4)));
  // ratings so the split is testable: 1600, 1550, 1500, 1450
  accounts.updateRanked(u[0].id, (s) => { s.rating = 1600; });
  accounts.updateRanked(u[1].id, (s) => { s.rating = 1550; });
  accounts.updateRanked(u[3].id, (s) => { s.rating = 1450; });

  // ---- game 1: normal end, ratings move ----
  const g1 = u.slice(0, 4);
  for (const x of g1.slice(0, 3)) await queueAndPlay(x);
  await wait(300);
  const st = await (await fetch(base + '/queue/status?type=ranked')).json();
  ok(st.queued === 3 && st.needed === 4, `ranked queue counts 3 / 4 (got ${st.queued} / ${st.needed})`);
  const casual = await (await fetch(base + '/queue/status')).json();
  ok(casual.queued === 0, 'casual queue unaffected');
  await queueAndPlay(g1[3]);
  await Promise.all(g1.map((x) => x.found));
  await until(() => g1.every((x) => x.pid));
  ok(new Set(g1.map((x) => x.gameId)).size === 1, 'all four sent to one game');
  ok(room(g1[0]).egg && room(g1[0]).ranked, 'it is an eggball ranked game');
  ok(g1.every((x) => x.hasShift), 'game page carries the double-Shift script');
  // snake: 1600 red, 1550 blue, 1500 blue, 1450 red
  ok(teamOf(g1[0]) === 1 && teamOf(g1[1]) === 2 && teamOf(g1[2]) === 2 && teamOf(g1[3]) === 1, 'teams split by rating (red 1600+1450, blue 1550+1500)');
  ok(g1.every((x) => room(x).players[x.pid].team === teamOf(x)), 'players actually on those teams');
  g1[0].sock.emit('switch'); await wait(200);
  ok(room(g1[0]).players[g1[0].pid].team === 1, 'switching teams is blocked');
  room(g1[0]).score.r = 2; games.endGame(g1[0].gameId); // red wins
  await wait(300);
  const r = g1.map((x) => accounts.rankedOf(accounts.byId(x.id)));
  ok(r[0].rating === 1616 && r[3].rating === 1466 && r[1].rating === 1534 && r[2].rating === 1484, `Elo: even teams, winners +16, losers -16 (got ${r.map((x) => x.rating).join(', ')})`);
  ok(r[0].wins === 1 && r[1].losses === 1, 'wins/losses recorded');
  ok(said([g1[0]], /Eggball rating: 1600 -> 1616 \(\+16\)/), 'player told their new rating');
  g1.forEach((x) => x.sock.disconnect());
  await wait(300);

  // ---- game 2: a leave, teammate votes to continue (1 of 1 needed in 2v2) ----
  const g2 = u.slice(0, 4);
  for (const x of g2) await queueAndPlay(x);
  await Promise.all(g2.map((x) => x.found));
  await until(() => g2.every((x) => x.pid));
  const leaver = g2.find((x) => teamOf(x) === 1);
  const mate = g2.find((x) => x !== leaver && teamOf(x) === 1);
  const others = g2.filter((x) => x !== leaver);
  leaver.sock.disconnect();
  ok(await until(() => said(others, /left\. Red team: double-tap Shift/)), 'leave announced with the vote');
  const opp = g2.find((x) => teamOf(x) === 2);
  opp.sock.emit('rankedContinue'); await wait(200);
  ok(room(mate).ranked.votes[1], "the other team can't vote for red");
  mate.sock.emit('rankedContinue');
  ok(await until(() => said(others, /Red voted to keep playing/)), 'teammate vote keeps the game going');
  ok(!room(mate).ended, 'game not voided');
  const lr = accounts.rankedOf(accounts.byId(leaver.id));
  ok(lr.bannedUntil === 0, 'no penalty until the game is over');
  games.endGame(mate.gameId);
  await wait(300);
  const lr2 = accounts.rankedOf(accounts.byId(leaver.id));
  ok(lr2.leaves === 1 && lr2.losses >= 1 && lr2.bannedUntil > Date.now() + 14 * 60000, 'leaver gets a loss and a 15 minute lockout');
  others.forEach((x) => x.sock.disconnect());
  await wait(300);
  // locked out of the queue
  await fetch(base + '/games/find?type=ranked', { headers: { cookie: leaver.cookie } });
  const lj = io(base + '/games/find', { extraHeaders: { cookie: leaver.cookie }, transports: ['websocket'], forceNew: true });
  const nre = new Promise((res) => lj.on('NotRankedEligible', res));
  lj.on('connect', () => lj.emit('JoinerSelections', {}));
  ok(/15 min/.test((await Promise.race([nre, wait(3000).then(() => ({ timeLeft: '' }))])).timeLeft), 'leaver refused by the ranked queue');
  lj.disconnect();

  // ---- game 3: a leave with no vote -> voided after 30 s, nobody else's rating moves ----
  const g3 = u.filter((x) => x !== leaver);
  for (const x of g3) await queueAndPlay(x);
  await Promise.all(g3.map((x) => x.found));
  await until(() => g3.every((x) => x.pid));
  const before = g3.map((x) => accounts.rankedOf(accounts.byId(x.id)).rating);
  const l3 = g3[0];
  l3.sock.disconnect();
  const rest = g3.slice(1);
  console.log('     (waiting 30 s for the vote to run out)');
  ok(await until(() => said(rest, /The game is voided:/), 35000), 'no vote: game voided');
  ok(room(rest[0]).ended, 'voided game ended');
  const after = g3.map((x) => accounts.rankedOf(accounts.byId(x.id)).rating);
  ok(rest.every((x, i) => after[i + 1] === before[i + 1]), 'stayers keep their rating');
  ok(after[0] < before[0], 'leaver still loses rating');
  rest.forEach((x) => x.sock.disconnect());

  const lb = await (await fetch(base + '/leaders')).text();
  ok(lb.includes(u[0].name) || lb.includes('Eggball Ranked'), 'leaders page lists ranked players');
  console.log(fails ? `${fails} FAILED` : 'all passed');
})().catch((e) => { console.error(e); fails++; }).finally(async () => {
  await wait(500);
  for (const f of ['accounts.json', 'logins.json']) { try { fs.unlinkSync(path.join(DATA, f)); } catch (e) { /* none */ } }
  process.exit(fails ? 1 : 0);
});
