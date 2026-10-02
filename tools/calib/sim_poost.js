// Simulates tagger -> flag carrier collisions in the engine and reports the tagger's radial dv,
// for comparison with the real-replay fit (tools/calib/poosts.py).
const fs = require('fs'), { PNG } = require('pngjs');
const { loadMap } = require('../../engine/mapLoader');
const { GameRoom } = require('../../engine/game');
const Box2D = require('../../engine/box2d'); const V = Box2D.Common.Math.b2Vec2;
const map = loadMap(PNG.sync.read(fs.readFileSync(__dirname + '/../../maps/83889.png')), JSON.parse(fs.readFileSync(__dirname + '/../../maps/83889.json')));
const fake = () => ({ emit() {}, disconnect() {} });
const cases = process.argv[2] === 'fc' ? [[0, -2], [0, -4], [0, -6], [0, -8], [0, -10], [1, -6], [-1, -6]] : [[0.3, 0], [1, 0], [2, 0], [3, 0], [5, 0], [8, 0], [1.5, -1.5], [0.5, 0.5]];
for (const [ta, va] of cases) {
  const room = new GameRoom({ id: 'sim', map });
  room.state = 1; room.startedPlayAt = Date.now();
  const c1 = fake(), c2 = fake();
  room.addClient(c1, { id: 'a', name: 'T' }, { team: 1 }); room.addClient(c2, { id: 'b', name: 'V' }, { team: 2 });
  const [t, v] = Object.values(room.players);
  v.flag = 1;
  // open floor area on Asida: put them 0.6m apart, tagger moving right at ta, victim moving at va
  const y = 2.4, x0 = 6.0;
  t.body.SetPosition(new V(x0, y)); v.body.SetPosition(new V(x0 + 0.6, y));
  t.body.SetLinearVelocity(new V(ta, 0)); v.body.SetLinearVelocity(new V(va, 0));
  let before = ta;
  for (let i = 0; i < 400 && !v.dead; i++) { before = t.body.GetLinearVelocity().x; room.step(); }
  const after = t.body.GetLinearVelocity().x;
  const closing = ta - va;
  const real = Math.max(1.53, 0.62 + 0.6 * closing);
  const reg = 1.191 + 0.495 * ta - 0.431 * va; // direct regression on tagger/victim speeds (tools/calib/poosts.py)
  console.log(`tagger ${ta} victim ${va} (closing ${closing.toFixed(1)}): engine dv ${(before - after).toFixed(2)} | real model ${real.toFixed(2)} | real regression ${reg.toFixed(2)}  popped=${v.dead}`);
  room.close();
}
process.exit(0);
