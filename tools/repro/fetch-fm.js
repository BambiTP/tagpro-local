// fetch-fm.js: downloads the Fortunate Maps JSON (map logic) for every fm_id seen in the given replay
// files/dirs (plus every GLTP map with --gltp) into ./fm-cache, one request per second. Skips maps
// already there, so batch.sh runs it before every batch and only new maps get fetched.
//   node tools/repro/fetch-fm.js [--gltp] [replay file or dir...]
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const meta = require('./gltp/map_metadata.json');
const ids = new Set();
if (process.argv.includes('--gltp')) for (const [id, m] of Object.entries(meta)) { ids.add(id); for (const e of m.equivalent_map_ids || []) ids.add(String(e)); }
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const dir of process.argv.slice(2).filter((a) => a !== '--gltp')) for (const f of fs.statSync(dir).isDirectory() ? walk(dir) : [dir]) {
  if (!f.endsWith('.gz')) continue;
  try {
    const head = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8', 0, 200000);
    const m = /"mapfile":"fm_id\/(\d+)"/.exec(head); if (m) ids.add(m[1]);
  } catch (e) { /* partial file */ }
}
const out = path.join(__dirname, 'fm-cache');
const todo = [...ids].filter((id) => !fs.existsSync(path.join(out, id + '.json')) && !fs.existsSync(path.join(__dirname, '../../maps', id + '.json')));
if (todo.length) console.error('fetching', todo.length, 'map(s) from Fortunate Maps');
(async () => {
  for (const id of todo) {
    try {
      const r = await fetch(`https://fortunatemaps.herokuapp.com/json/${id}`);
      if (r.ok) fs.writeFileSync(path.join(out, id + '.json'), Buffer.from(await r.arrayBuffer()));
      else console.error('FAIL', id, r.status);
    } catch (e) { console.error('ERR', id, e.message); }
    await new Promise((res) => setTimeout(res, 1000));
  }
})();
