// tournament-test.js - Competitive tab logic without a server: every bracket format (with byes and
// random results) ends with one champion and the right number of losses for everyone else; round
// robin pairs every team once and adds playoffs; best-of and tie rules; draft pick orders.
//   node tools/tournament-test.js
const B = require('../server/bracket');
const { pickOrder } = require('../server/tournaments');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL ' + msg); fails++; } };
const teams = (n) => Array.from({ length: n }, (_, i) => 't' + i);
const playAll = (ms, done, bestOf = 1) => {
  for (let guard = 0; guard < 2000 && !done(); guard++) {
    const m = ms.find(B.playable);
    if (!m) break;
    const r = Math.random(), winner = r < 0.1 ? 'tie' : r < 0.55 ? 'a' : 'b';
    B.recordGame(m, { winner, score: { a: winner === 'a' ? 2 : 1, b: winner === 'b' ? 2 : 1 } }, bestOf);
    B.resolve(ms);
  }
};

for (let n = 2; n <= 20; n++) {
  for (const format of ['single', 'double']) {
    for (const bestOf of [1, 3]) {
      const ids = teams(n), ms = B.resolve(format === 'single' ? B.singleElim(ids) : B.doubleElim(ids));
      playAll(ms, () => B.champion(ms, format, ids), bestOf);
      const champ = B.champion(ms, format, ids);
      const losses = {};
      for (const m of ms) if (m.done && !m.bye) losses[m.loser] = (losses[m.loser] || 0) + 1;
      ok(champ && ids.includes(champ), `${format} ${n} teams bo${bestOf}: has a champion`);
      ok(ids.every((t) => t === champ || losses[t] === (format === 'single' ? 1 : 2)), `${format} ${n} teams bo${bestOf}: everyone else out with ${format === 'single' ? 1 : 2} losses`);
      ok((losses[champ] || 0) <= (format === 'single' ? 0 : 1), `${format} ${n} teams: champion lost at most ${format === 'single' ? 0 : 1}`);
      ok(ms.every((m) => !m.done || m.bye || m.wins[m.winner === m.a ? 'a' : 'b'] === Math.ceil(bestOf / 2)), `${format} ${n} teams bo${bestOf}: winners reached ${Math.ceil(bestOf / 2)} wins`);
    }
  }
  const ids = teams(n), rr = B.roundRobin(ids);
  const pairs = new Set(rr.map((m) => [m.a, m.b].sort().join()));
  ok(rr.length === n * (n - 1) / 2 && pairs.size === rr.length, `round robin ${n} teams: every pair once`);
  const perRound = {};
  ok(rr.every((m) => { const k = m.round; perRound[k] = perRound[k] || new Set(); const dup = perRound[k].has(m.a) || perRound[k].has(m.b); perRound[k].add(m.a).add(m.b); return !dup; }), `round robin ${n} teams: nobody plays twice in a round`);
  playAll(rr, () => rr.every((m) => m.done));
  const table = B.standings(rr, ids);
  ok(table.reduce((s, r) => s + r.wins, 0) === rr.length && rr.every((x) => x.winner), `round robin ${n} teams: every match has a winner`);
  ok(B.champion(rr, 'roundrobin', ids, 0) === table[0].team && B.champion(rr, 'roundrobin', ids, 4) === null, `round robin ${n} teams: table leader wins without playoffs only`);
}

// seeding: 1 v 8, 4 v 5, 2 v 7, 3 v 6; byes go to the top seeds
ok(B.seedOrder(8).join() === '1,8,4,5,2,7,3,6', 'seed order for 8');
const six = B.resolve(B.singleElim(teams(6)));
ok(six.filter((m) => m.bye).map((m) => m.winner).sort().join() === 't0,t1', '6 teams: seeds 1 and 2 get the byes');

// best of 3: a level game isn't counted; first to 2 wins
const m = B.singleElim(teams(2))[0];
B.recordGame(m, { winner: 'tie', score: { a: 1, b: 1 } }, 3);
B.recordGame(m, { winner: 'a', score: { a: 1, b: 0 } }, 3);
ok(!m.done && m.wins.a === 1 && m.games.length === 2 && !m.games[0].counted, 'level game is played again');
B.recordGame(m, { winner: 'b', score: { a: 0, b: 1 } }, 3);
B.recordGame(m, { winner: 'a', score: { a: 3, b: 0 } }, 3);
ok(m.done && m.winner === 't0', 'best of 3 decided at 2 wins');

// grand final reset: losers-bracket team wins the first grand final -> a second one
const de = B.resolve(B.doubleElim(teams(4)));
const win = (id, side) => { const x = de.find((y) => y.id === id); B.recordGame(x, { winner: side, score: { a: 1, b: 0 } }, 1); B.resolve(de); };
win('W1-1', 'a'); win('W1-2', 'a'); win('W2-1', 'a'); win('L1-1', 'a'); win('L2-1', 'a'); win('GF', 'b');
ok(de.some((x) => x.id === 'GF2') && B.champion(de, 'double', teams(4)) === null, 'grand final reset added');
win('GF2', 'b');
ok(B.champion(de, 'double', teams(4)) === de.find((x) => x.id === 'GF').b, 'losers side wins after the reset');

// draft orders
ok(pickOrder(['a', 'b', 'c'], 3, 'snake').join('') === 'abccbaabc', 'snake order');
ok(pickOrder(['a', 'b', 'c'], 3, 'straight').join('') === 'abcabcabc', 'straight order');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
