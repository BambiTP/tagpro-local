// node tools/make-admin.js <username>   - lets that account open /admin (no restart needed)
const fs = require('fs'), path = require('path');
const u = process.argv[2];
if (!u) { console.error('usage: node tools/make-admin.js <username>'); process.exit(1); }
const f = path.join(__dirname, '..', 'data', 'admins.json');
let list = []; try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { list = []; }
if (!list.map((x) => x.toLowerCase()).includes(u.toLowerCase())) list.push(u);
fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(list));
console.log('admins:', list.join(', '));
