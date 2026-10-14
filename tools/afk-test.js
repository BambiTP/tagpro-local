// Disable AFK kick (group setting): an idle player is warned and kicked normally, and never with
// the setting on. Run: node tools/afk-test.js
const P = __dirname + '/../';
const { GameRoom } = require(P + 'engine/game.js');
const { loadMap, trimPng } = require(P + 'engine/mapLoader');
const { PNG } = require(P + 'node_modules/pngjs');
const groupDefaults = require(P + 'server/groupDefaults.json');
const fs = require('fs');
const map = loadMap(PNG.sync.read(trimPng(fs.readFileSync(P + 'maps/74431.png'))), JSON.parse(fs.readFileSync(P + 'maps/74431.json')));
let fails = 0; const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };

// an idle player for 40 s of play; returns what its client was sent
function idle(settings) {
  let t = 0;
  const room = new GameRoom({ id: 'x', map, settings, now: () => t });
  const c = { got: [], emit(ev, d) { this.got.push(ev === 'chat' ? d.message : ev === 'disconnectReason' ? 'reason:' + d : ev); }, disconnect() { this.gone = true; } };
  room.addClient(c, { id: 'A', name: 'A' });
  room.state = 1;
  for (let i = 0; i < 40 * 60; i++) { t += 1000 / 60; room.step(); }
  room.closed = true; for (const h of room.timers) clearTimeout(h);
  return { warned: c.got.some((m) => /AFK/.test(m)), kicked: !!c.gone && c.got.includes('reason:afk'), players: Object.keys(room.players).length };
}

const normal = idle({});
check('idle player warned by default', normal.warned);
check('idle player kicked by default', normal.kicked && normal.players === 0);
const off = idle({ disableAfk: true });
check('not warned with Disable AFK Kick', !off.warned);
check('not kicked with Disable AFK Kick', !off.kicked && off.players === 1);
check('group setting exists, off by default', groupDefaults.settings.some(([k, v]) => k === 'disableAfk' && v === false));
process.exit(fails ? 1 : 0);
