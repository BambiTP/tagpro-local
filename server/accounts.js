// accounts.js - simple username/password accounts (local replacement for the real site's
// Google/etc. logins). Stored in data/accounts.json; logins (tpid cookie -> username) persist in
// data/logins.json so restarts don't log people out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const flairs = require('./flairs.json');

const DATA = path.join(__dirname, '..', 'data');
const ACCOUNTS = path.join(DATA, 'accounts.json');
const LOGINS = path.join(DATA, 'logins.json');
fs.mkdirSync(DATA, { recursive: true });

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const accounts = load(ACCOUNTS); // lower(username) -> account
const logins = load(LOGINS);     // tpid -> lower(username)
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  for (const [f, d] of [[ACCOUNTS, accounts], [LOGINS, logins]]) {
    fs.writeFileSync(f + '.tmp', JSON.stringify(d));
    fs.renameSync(f + '.tmp', f);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}
// don't lose a pending write when the server stops (deploys restart it with SIGTERM)
process.on('exit', () => { if (saveTimer) flush(); });
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => process.exit(0));

const flairByKey = Object.fromEntries(flairs.map((f) => [f.key, f]));
const PRINTABLE = /^[\x20-\x7E]+$/;

// async: hashing runs off the main thread, so log in attempts don't stall games
const hash = (password, salt) => new Promise((ok, fail) => crypto.scrypt(password, salt, 64, (e, k) => (e ? fail(e) : ok(k.toString('hex')))));

function validName(n, max) {
  n = String(n || '').trim();
  if (!n || n.length > max || !PRINTABLE.test(n)) return null;
  return n;
}

async function register(username, password) {
  const u = validName(username, 16);
  if (!u || !/^[A-Za-z0-9_ -]+$/.test(u)) return { error: 'Usernames are 1-16 letters, numbers, spaces, _ or -.' };
  if (String(password || '').length < 6) return { error: 'Passwords need at least 6 characters.' };
  const key = u.toLowerCase();
  if (accounts[key]) return { error: 'That username is taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const h = await hash(String(password), salt);
  if (accounts[key]) return { error: 'That username is taken.' };
  accounts[key] = { id: crypto.randomBytes(12).toString('hex'), username: u, salt, hash: h, displayName: u.slice(0, 12), flair: null, created: Date.now() };
  save();
  return { account: accounts[key] };
}

async function login(username, password) {
  const a = accounts[String(username || '').trim().toLowerCase()];
  if (!a) return { error: 'Wrong username or password.' };
  const h = await hash(String(password || ''), a.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(a.hash, 'hex'))) return { error: 'Wrong username or password.' };
  return { account: a };
}

// a cookie that is logged in to an account (still valid after a restart)
const knownSession = (id) => Object.prototype.hasOwnProperty.call(logins, id);

// attach / detach an account to a browser session (tpid)
function bind(session, account) {
  logins[session.id] = account.username.toLowerCase();
  save();
  apply(session);
}
function unbind(session) {
  delete logins[session.id];
  save();
  session.account = null; session.auth = null; session.flair = null; session.name = 'Some Ball';
}

// copy account state onto the session (name/flair/auth used by groups and games)
function apply(session) {
  const a = accounts[logins[session.id]];
  if (!a) { session.account = null; return session; }
  if (!a.id) { a.id = crypto.randomBytes(12).toString('hex'); save(); } // accounts made before replays existed
  session.account = a;
  session.auth = true;
  session.name = a.displayName;
  session.flair = a.flair ? flairByKey[a.flair] || null : null;
  session.degree = degreeFor((a.stats && a.stats.wins) || 0);
  return session;
}

function setDisplayName(session, name) {
  const n = validName(name, 12);
  if (!session.account) return { error: 'Not logged in.' };
  if (!n) return { error: 'Names are 1-12 printable characters.' };
  session.account.displayName = n;
  save(); apply(session);
  return { success: true };
}

function setFlair(session, key) {
  if (!session.account) return { error: 'Not logged in.' };
  if (key && !flairByKey[key]) return { error: 'Unknown flair.' };
  session.account.flair = key || null;
  save(); apply(session);
  return { success: true };
}

// ---- public game stats + degrees (gentle curve: degrees 1-5 need 1 win each, 6-10 need 2 each, ...)
const STAT_KEYS = ['tags', 'pops', 'grabs', 'drops', 'hold', 'captures', 'prevent', 'returns', 'support', 'powerups'];
function winsForDegree(d) { let w = 0; for (let l = 1; l <= d; l++) w += Math.ceil(l / 5); return w; }
function degreeFor(wins) { let d = 0; while (d < 360 && winsForDegree(d + 1) <= wins) d++; return d; }
function emptyStats() { const s = { games: 0, wins: 0, losses: 0, ties: 0, timePlayed: 0, score: 0 }; for (const k of STAT_KEYS) s[k] = 0; return s; }

// result: { won, tied, timePlayed (ms), score, tags, pops, ... }; returns { degree, degreeUp }
function recordGame(accountId, result) {
  const a = byId(accountId);
  if (!a) return null;
  const st = a.stats || (a.stats = emptyStats());
  const before = degreeFor(st.wins);
  st.games++;
  if (result.tied) st.ties++; else if (result.won) st.wins++; else st.losses++;
  st.timePlayed += result.timePlayed || 0;
  st.score += result.score || 0;
  for (const k of STAT_KEYS) st[k] += result[k] || 0;
  save();
  const after = degreeFor(st.wins);
  return { degree: after, degreeUp: after > before };
}

function setTextures(session, body) {
  if (!session.account) return;
  const pack = {};
  for (const k of ['name', 'tiles', 'speedpad', 'speedpadRed', 'speedpadBlue', 'portal', 'portalRed', 'portalBlue', 'splats']) if (typeof body[k] === 'string') pack[k] = body[k].slice(0, 300);
  session.account.textures = pack; save();
}

function search(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return [];
  return Object.values(accounts).filter((a) => a.id && (a.username.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q)))
    .slice(0, 50).map((a) => ({ ...a, flairObj: a.flair ? flairByKey[a.flair] : null }));
}
function byId(id) { return Object.values(accounts).find((a) => a.id === id) || null; }

module.exports = { recordGame, degreeFor, winsForDegree, emptyStats, STAT_KEYS, setTextures, search, byId, register, login, knownSession, bind, unbind, apply, setDisplayName, setFlair, flairs, flairByKey };
