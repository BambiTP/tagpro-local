// node tools/fm-fetch.js <fortunateMapsId...>  -> maps/<id>.png + maps/<id>.json
const fs = require('fs');
(async () => {
  for (const id of process.argv.slice(2)) for (const k of ['png', 'json']) {
    const r = await fetch(`https://fortunatemaps.herokuapp.com/${k}/${id}`);
    if (!r.ok) { console.error('FAIL', id, k, r.status); continue; }
    fs.writeFileSync(`${__dirname}/../maps/${id}.${k}`, Buffer.from(await r.arrayBuffer()));
  }
})();
