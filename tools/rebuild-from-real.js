// Rebuilds a map from the exact tiles the real server sent (a replay's "map" packet), taking the
// logic (portals/buttons/gates/spawns) from the closest Fortunate Maps upload. Used when the live
// map was edited after its last FM upload.
//   node tools/rebuild-from-real.js "<map name>" <fmIdForLogic>
const fs = require('fs'), path = require('path'), { PNG } = require('pngjs');
const { COLOR_TO_TILE } = require('../engine/mapLoader');
const [name, fmId] = process.argv.slice(2);
const ROOT = path.join(__dirname, '..');

let real = null;
for (const dir of ['ref/replay-archive', 'ref/replays', ...fs.readdirSync(path.join(ROOT, 'ref')).filter((d) => d.startsWith('live') && fs.statSync(path.join(ROOT, 'ref', d)).isDirectory()).map((d) => 'ref/' + d)]) {
  for (const f of fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []) {
    const line = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n').find((l) => l.startsWith('[') && l.includes('"map"') && l.includes(JSON.stringify(name)));
    if (line) { const p = JSON.parse(line); if (p[1] === 'map' && p[2].info.name === name) { real = p[2]; break; } }
  }
  if (real) break;
}
if (!real) { console.error('no real map packet for', name); process.exit(1); }

// tile id -> PNG colour; dynamic/state variants collapse to their base tile
const TILE_TO_COLOR = {};
for (const [hex, t] of Object.entries(COLOR_TO_TILE)) if (TILE_TO_COLOR[t] === undefined) TILE_TO_COLOR[t] = hex;
const base = (v) => {
  const f = parseFloat(v);
  if (f >= 1 && f < 2) return f;                         // walls incl. diagonals
  if (f >= 9 && f < 10) return 9;                        // gates (state comes from JSON fields)
  if ([13, 24, 25].includes(Math.floor(f))) return Math.floor(f); // portals (exit state from JSON)
  if (Math.floor(f) === 6) return 6;                     // powerups
  return Math.floor(f);                                  // 5.1/3.1/10.1... -> base tile
};
const W = real.tiles.length, H = real.tiles[0].length;
const png = new PNG({ width: W, height: H });
const unknown = new Set();
for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
  const t = base(real.tiles[x][y]);
  const hex = TILE_TO_COLOR[t];
  if (!hex) unknown.add(t);
  const i = (y * W + x) * 4;
  const c = hex || '000000';
  png.data[i] = parseInt(c.slice(0, 2), 16); png.data[i + 1] = parseInt(c.slice(2, 4), 16); png.data[i + 2] = parseInt(c.slice(4, 6), 16); png.data[i + 3] = 255;
}
(async () => {
  const j = await (await fetch(`https://fortunatemaps.herokuapp.com/json/${fmId}`)).json();
  j.info = Object.assign({}, j.info, real.info);
  const key = `real-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  fs.writeFileSync(path.join(ROOT, 'maps', key + '.png'), PNG.sync.write(png));
  fs.writeFileSync(path.join(ROOT, 'maps', key + '.json'), JSON.stringify(j));
  const rot = path.join(ROOT, 'maps', 'rotation.json');
  const list = fs.existsSync(rot) ? JSON.parse(fs.readFileSync(rot, 'utf8')) : [];
  if (!list.includes(key)) list.push(key);
  fs.writeFileSync(rot, JSON.stringify(list));
  console.log(`${name}: wrote maps/${key} (${W}x${H}) logic from FM ${fmId}${unknown.size ? ', unknown tiles ' + [...unknown] : ''}`);
})();
