// node tools/validate-map.js <replay.ndjson> <fmId...> : diff our PNG decode vs the real server's map packet
const { PNG } = require('pngjs'), fs = require('fs'), { loadMap, trimPng } = require('../engine/mapLoader');
const [rep, ...ids] = process.argv.slice(2);
const real = fs.readFileSync(rep, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(p => p[1] === 'map')[2];
for (const id of ids) {
  const m = loadMap(PNG.sync.read(trimPng(fs.readFileSync(`${__dirname}/../maps/${id}.png`))), JSON.parse(fs.readFileSync(`${__dirname}/../maps/${id}.json`)));
  const a = m.tiles, b = real.tiles;
  if (a.length !== b.length || a[0].length !== b[0].length) { console.log(id, m.info.name, 'size', a.length, a[0].length, 'vs', b.length, b[0].length); continue; }
  let diff = 0; const cnt = {};
  for (let x = 0; x < a.length; x++) for (let y = 0; y < a[0].length; y++) if (a[x][y] !== b[x][y]) { diff++; const k = a[x][y] + '->' + b[x][y]; cnt[k] = (cnt[k] || 0) + 1; }
  console.log(id, m.info.name, 'diff', diff, cnt, m.unknownColors);
}
