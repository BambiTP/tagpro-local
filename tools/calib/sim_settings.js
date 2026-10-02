// Checks map-test reset (R) and 250ms grab invincibility in the engine.
const fs = require('fs'), { PNG } = require('pngjs');
const { loadMap } = require('../../engine/mapLoader');
const { GameRoom } = require('../../engine/game');
const V = require('../../engine/box2d').Common.Math.b2Vec2;
const map = loadMap(PNG.sync.read(fs.readFileSync(__dirname + '/../../maps/74431.png')), JSON.parse(fs.readFileSync(__dirname + '/../../maps/74431.json')));
const fake = (log) => ({ emit(ev, d) { if (log) log.push([ev, d]); }, disconnect() {} });
const count = (room, f) => { let n = 0; for (const c of room.tiles) for (const t of c) if (f(String(t))) n++; return n; };

// map test reset
const room = new GameRoom({ id: 't', map, settings: { mapTestingMode: true } });
room.state = 1;
const log = []; const c = fake(log);
room.addClient(c, { id: 'a', name: 'A' }, { team: 1 });
console.log('clientInfo.mapTestingMode =', log.find(([e]) => e === 'clientInfo')[1].mapTestingMode);
for (let x = 0; x < room.W; x++) for (let y = 0; y < room.H; y++) { const t = String(room.tiles[x][y]); if (t === '5') room.setTile(x, y, '5.1'); if (t === '10') room.setTile(x, y, '10.1'); if (t === '6') room.setTile(x, y, 6.12); }
console.log('before reset: used boosts', count(room, (t) => t === '5.1'), 'used bombs', count(room, (t) => t === '10.1'), 'empty pups', count(room, (t) => t.startsWith('6.') && t.length > 3));
c.onEvent('resetMap');
console.log('after  reset: used boosts', count(room, (t) => t === '5.1'), 'used bombs', count(room, (t) => t === '10.1'), 'ready pups', count(room, (t) => /^6\.[1-4]$/.test(t)), '| boosts', count(room, (t) => t === '5'), 'bombs', count(room, (t) => t === '10'));
room.close();

// grab invincibility
for (const delay of [100, 400]) {
  const r = new GameRoom({ id: 'g', map }); r.state = 1;
  r.addClient(fake(), { id: 'a', name: 'FC' }, { team: 1 }); r.addClient(fake(), { id: 'b', name: 'D' }, { team: 2 });
  const [fc, d] = Object.values(r.players);
  r.grabFlag(fc, 2);
  fc.invincibleUntil = Date.now() + 250 - delay; // pretend the grab happened `delay` ms ago
  r.enemyContact(fc, d);
  console.log(`tagged ${delay}ms after grab -> FC popped: ${fc.dead}`);
  r.close();
}

// spacebar / powerup settings
const mk = (settings) => { const r = new GameRoom({ id: 's', map, settings }); r.state = 1; r.addClient(fake(), { id: 'a', name: 'A' }, { team: 1 }); r.addClient(fake(), { id: 'b', name: 'B' }, { team: 2 }); return [r, ...Object.values(r.players)]; };
{ const [r, a] = mk({ combinejjrb: true }); r.givePowerup(a, 1); console.log('combinejjrb: jj', a.jukeJuice, 'rb', a.bomb, 's-powerups', a['s-powerups']); r.close(); }
{ const [r, a] = mk({ jukeJuiceBoost: true, jukeJuiceBoostPower: 70 }); r.givePowerup(a, 1); a.body.SetLinearVelocity(new V(1, 0)); r.spacebar(a); console.log('jj boost: speed', a.body.GetLinearVelocity().Length().toFixed(2), 'jj left', a.jukeJuice); r.close(); }
{ const [r, a] = mk({ spacebarDetonateAll: false }); r.givePowerup(a, 2); r.givePowerup(a, 1); r.settings.jukeJuiceBoost = true; r.spacebar(a); console.log('order (rb first): after 1 press rb', a.bomb, 'jj', a.jukeJuice); r.close(); }
{ const [r, a] = mk({ spacebarDetonateAll: true, jukeJuiceBoost: true }); r.givePowerup(a, 2); r.givePowerup(a, 1); a.body.SetLinearVelocity(new V(1, 0)); r.spacebar(a); console.log('detonate all: rb', a.bomb, 'jj', a.jukeJuice); r.close(); }
{ const [r, a, b] = mk({ rollingBombBehavior: 'default' }); r.givePowerup(a, 2); r.enemyContact(a, b); console.log('default rb on enemy touch: still has rb', a.bomb); r.pop(a, b); console.log('default rb on death: rb', a.bomb); r.close(); }
{ const [r, a, b] = mk({ rollingBombBehavior: 'classic' }); r.givePowerup(a, 2); r.spacebar(a); console.log('classic rb after space: rb', a.bomb); r.enemyContact(a, b); console.log('classic rb on enemy touch: rb', a.bomb); r.close(); }
// overtime respawn increment
{ const [r, a, b] = mk({}); r.state = 5; r.overtimeStartedAt = Date.now(); console.log('OT respawn: before pops', r.respawnDelay()); r.pop(a, b); r.pop(b, a); console.log('OT respawn after 2 pops', r.respawnDelay()); r.close(); }
// overtime juke juice on grab
{ const [r, a] = mk({ overtimeJukeJuice: true }); r.state = 5; r.grabFlag(a, 2); console.log('OT grab gives jj:', a.jukeJuice); r.close(); }
// clutch time
for (const mode of ['tied', 'winnable']) {
  const [r, a, b] = mk({ lastPossession: mode }); r.grabFlag(a, 2); r.score = mode === 'tied' ? { r: 1, b: 1 } : { r: 0, b: 1 };
  r.stateEndsAt = Date.now() - 1; r.updateClock(Date.now());
  console.log(`clutch ${mode}: state ${r.state} (7=clutch)`);
  r.pop(a, b); r.updateClock(Date.now()); console.log(`  after FC pops: state ${r.state} ended ${r.ended}`); r.close();
}
process.exit(0);
