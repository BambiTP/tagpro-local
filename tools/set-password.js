// node tools/set-password.js <username> [new password]   - resets an account's password
// With no password given, a random one is made and printed. Every browser logged in to the account
// is logged out. Stop the server first (systemctl stop tagpro): it keeps accounts in memory and would
// write the old password back.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [u, given] = process.argv.slice(2);
if (!u) { console.error('usage: node tools/set-password.js <username> [new password]'); process.exit(1); }
const dir = path.join(__dirname, '..', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const write = (f, d) => { fs.writeFileSync(path.join(dir, f + '.tmp'), JSON.stringify(d)); fs.renameSync(path.join(dir, f + '.tmp'), path.join(dir, f)); };

const accounts = read('accounts.json');
const key = u.trim().toLowerCase();
if (!Object.hasOwn(accounts, key)) {
  console.error(`No account "${u}". Accounts: ${Object.values(accounts).map((a) => a.username).join(', ')}`);
  process.exit(1);
}
const password = given || crypto.randomBytes(9).toString('base64url');
if (password.length < 6) { console.error('Passwords need at least 6 characters.'); process.exit(1); }
const a = accounts[key];
a.salt = crypto.randomBytes(16).toString('hex');
a.hash = crypto.scryptSync(password, a.salt, 64).toString('hex'); // same as server/accounts.js
write('accounts.json', accounts);

let logins = {};
try { logins = read('logins.json'); } catch (e) { /* none yet */ }
const before = Object.keys(logins).length;
for (const [id, name] of Object.entries(logins)) if (name === key) delete logins[id];
write('logins.json', logins);
console.log(`Password for ${a.username} set${given ? '' : ' to: ' + password} (logged out ${before - Object.keys(logins).length} browser(s)).`);
