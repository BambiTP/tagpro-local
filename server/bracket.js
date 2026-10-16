// bracket.js - tournament brackets as plain data (no server state), used by tournaments.js.
// A match is { id, bracket, round, label, a, b, src, games, wins, winner, loser, done }. `a`/`b` are
// team ids, BYE for an empty slot, or null until `src` fills them: src.a = { m: matchId, take:
// 'winner'|'loser' }. A match against BYE finishes by itself, so byes (and the losers of bye
// matches in a double elimination bracket) flow through the same way as played matches.
const BYE = 'BYE';

// seed positions for a bracket of size p (a power of two): 1 v p, then 4 v 5, 2 v 7, 3 v 6, ...
function seedOrder(p) {
  let s = [1, 2];
  while (s.length < p) s = s.flatMap((x) => [x, s.length * 2 + 1 - x]);
  return s;
}
const pow2 = (n) => { let p = 2; while (p < n) p *= 2; return p; };

function match(id, bracket, round, label, a, b, src) {
  return { id, bracket, round, label, a: a ?? null, b: b ?? null, src: src || null, games: [], wins: { a: 0, b: 0 }, winner: null, loser: null, done: false };
}
const from = (m, take) => ({ m: m.id, take });

// teams: ids, best seed first. prefix 'W' (main bracket) or 'P' (playoffs after round robin)
function singleElim(teams, prefix = 'W') {
  const p = pow2(teams.length), rounds = Math.log2(p), out = [];
  const slots = seedOrder(p).map((seed) => teams[seed - 1] || BYE);
  let prev = [];
  for (let r = 1; r <= rounds; r++) {
    const cur = [];
    for (let i = 0; i < p / 2 ** r; i++) {
      const left = rounds - r;
      const label = left === 0 ? 'Final' : left === 1 ? 'Semifinal' : left === 2 ? 'Quarterfinal' : `Round ${r}`;
      const m = r === 1 ? match(`${prefix}${r}-${i + 1}`, prefix, r, label, slots[2 * i], slots[2 * i + 1])
        : match(`${prefix}${r}-${i + 1}`, prefix, r, label, null, null, { a: from(prev[2 * i], 'winner'), b: from(prev[2 * i + 1], 'winner') });
      cur.push(m);
    }
    out.push(...cur);
    prev = cur;
  }
  return out;
}

// winners bracket as above; the losers bracket alternates "drop-in" rounds (its survivors meet the
// teams just knocked out of the winners bracket, in reverse order to avoid quick rematches) and
// rounds where its own survivors play each other. Grand final: winners champion v losers champion;
// if the losers side wins it, a second grand final is added (each team then has one loss).
function doubleElim(teams) {
  const w = singleElim(teams, 'W');
  for (const m of w) m.label = m.label === 'Final' ? 'Winners final' : m.label === 'Semifinal' ? 'Winners semifinal' : 'Winners ' + m.label.toLowerCase();
  const p = pow2(teams.length), k = Math.log2(p);
  const wr = (r) => w.filter((m) => m.round === r);
  const l = [];
  let prev = [], lr = 0;
  const add = (ms) => { l.push(...ms); prev = ms; };
  if (k > 1) {
    lr++;
    const r1 = wr(1);
    add(Array.from({ length: p / 4 }, (_, j) => match(`L${lr}-${j + 1}`, 'L', lr, `Losers round ${lr}`, null, null, { a: from(r1[2 * j], 'loser'), b: from(r1[2 * j + 1], 'loser') })));
    for (let r = 2; r <= k; r++) {
      const drop = wr(r), c = drop.length;
      lr++;
      add(prev.map((pm, j) => match(`L${lr}-${j + 1}`, 'L', lr, `Losers round ${lr}`, null, null, { a: from(pm, 'winner'), b: from(drop[c - 1 - j], 'loser') })));
      if (r < k) {
        lr++;
        const before = prev;
        add(Array.from({ length: before.length / 2 }, (_, j) => match(`L${lr}-${j + 1}`, 'L', lr, `Losers round ${lr}`, null, null, { a: from(before[2 * j], 'winner'), b: from(before[2 * j + 1], 'winner') })));
      }
    }
    prev[0].label = 'Losers final';
  }
  const wf = w[w.length - 1];
  const gf = match('GF', 'GF', 1, 'Grand final', null, null, { a: from(wf, 'winner'), b: k > 1 ? from(prev[0], 'winner') : from(wf, 'loser') });
  return [...w, ...l, gf];
}

// every team plays every other once; the circle method gives rounds where nobody plays twice
function roundRobin(teams) {
  const list = teams.length % 2 ? [...teams, BYE] : [...teams];
  const n = list.length, out = [];
  for (let r = 0; r < n - 1; r++) {
    let i = 0;
    for (let j = 0; j < n / 2; j++) {
      const a = list[j], b = list[n - 1 - j];
      if (a !== BYE && b !== BYE) out.push(match(`RR${r + 1}-${++i}`, 'RR', r + 1, `Round ${r + 1}`, a, b));
    }
    list.splice(1, 0, list.pop()); // rotate everyone but the first
  }
  return out;
}

const byId = (matches) => Object.fromEntries(matches.map((m) => [m.id, m]));

// fill slots from finished matches and finish bye matches, until nothing changes
function resolve(matches) {
  const ids = byId(matches);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of matches) {
      if (m.done) continue;
      for (const side of ['a', 'b']) {
        const s = m.src && m.src[side];
        if (m[side] === null && s && ids[s.m] && ids[s.m].done) { m[side] = ids[s.m][s.take]; changed = true; }
      }
      if (m.a !== null && m.b !== null && (m.a === BYE || m.b === BYE)) {
        m.done = true; m.bye = true;
        m.winner = m.a === BYE ? m.b : m.a;
        m.loser = m.a === BYE ? m.a : m.b;
        changed = true;
      }
    }
  }
  // grand final reset
  const gf = ids.GF;
  if (gf && gf.done && !gf.bye && gf.winner === gf.b && !ids.GF2) {
    matches.push(match('GF2', 'GF', 2, 'Grand final (reset)', gf.a, gf.b));
  }
  return matches;
}

// a match is playable once both teams are known and neither is a bye
const playable = (m) => !m.done && m.a !== null && m.b !== null && m.a !== BYE && m.b !== BYE;

// a game's result: winner 'a' | 'b' | 'tie', score { a, b }. Best of N: first to ceil(N/2) wins.
// Ties don't count in elimination (play again); in round robin a game is a game, and a match
// that runs out of games level is a draw (winner null, draw true).
function recordGame(m, game, bestOf, roundRobinMatch) {
  const need = Math.ceil(bestOf / 2);
  const counts = game.winner !== 'tie' || roundRobinMatch;
  m.games.push(Object.assign({}, game, { counted: counts }));
  if (!counts) return m;
  if (game.winner !== 'tie') m.wins[game.winner]++;
  const played = m.games.filter((g) => g.counted).length;
  if (m.wins.a >= need || m.wins.b >= need) finish(m, m.wins.a > m.wins.b ? 'a' : 'b');
  else if (roundRobinMatch && played >= bestOf) {
    if (m.wins.a === m.wins.b) { m.done = true; m.draw = true; } else finish(m, m.wins.a > m.wins.b ? 'a' : 'b');
  }
  return m;
}
function finish(m, side) {
  m.done = true;
  m.winner = m[side];
  m.loser = m[side === 'a' ? 'b' : 'a'];
}

// round robin table: 2 points a win, 1 a draw; then wins, then score difference, then seed
function standings(matches, teams) {
  const row = Object.fromEntries(teams.map((t, i) => [t, { team: t, seed: i, played: 0, wins: 0, losses: 0, draws: 0, points: 0, for: 0, against: 0 }]));
  for (const m of matches) {
    if (m.bracket !== 'RR' || !m.done || m.bye || !row[m.a] || !row[m.b]) continue;
    const A = row[m.a], B = row[m.b];
    A.played++; B.played++;
    for (const g of m.games) if (g.counted) { A.for += g.score.a; A.against += g.score.b; B.for += g.score.b; B.against += g.score.a; }
    if (m.draw) { A.draws++; B.draws++; A.points++; B.points++; } else {
      const W = m.winner === m.a ? A : B, L = W === A ? B : A;
      W.wins++; L.losses++; W.points += 2;
    }
  }
  return Object.values(row).sort((x, y) => y.points - x.points || y.wins - x.wins || (y.for - y.against) - (x.for - x.against) || x.seed - y.seed);
}

// the champion, once the tournament is decided (null before)
function champion(matches, format, teams, playoffTeams) {
  const ids = byId(matches);
  if (format === 'single') { const f = matches.filter((m) => m.bracket === 'W').pop(); return f && f.done ? f.winner : null; }
  if (format === 'double') {
    if (ids.GF2) return ids.GF2.done ? ids.GF2.winner : null;
    return ids.GF && ids.GF.done && ids.GF.winner === ids.GF.a ? ids.GF.winner : null;
  }
  const playoffs = matches.filter((m) => m.bracket === 'P');
  if (playoffs.length) { const f = playoffs[playoffs.length - 1]; return f.done ? f.winner : null; }
  if (playoffTeams >= 2) return null;
  const rr = matches.filter((m) => m.bracket === 'RR');
  return rr.every((m) => m.done) ? standings(matches, teams)[0].team : null;
}

module.exports = { BYE, seedOrder, singleElim, doubleElim, roundRobin, resolve, playable, recordGame, standings, champion };
