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
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const [f, d] of [[ACCOUNTS, accounts], [LOGINS, logins]]) {
      fs.writeFileSync(f + '.tmp', JSON.stringify(d));
      fs.renameSync(f + '.tmp', f);
    }
  }, 200);
}

const flairByKey = Object.fromEntries(flairs.map((f) => [f.key, f]));
const PRINTABLE = /^[\x20-\x7E]+$/;

function hash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }

function validName(n, max) {
  n = String(n || '').trim();
  if (!n || n.length > max || !PRINTABLE.test(n)) return null;
  return n;
}

function register(username, password) {
  const u = validName(username, 16);
  if (!u || !/^[A-Za-z0-9_ -]+$/.test(u)) return { error: 'Usernames are 1-16 letters, numbers, spaces, _ or -.' };
  if (String(password || '').length < 6) return { error: 'Passwords need at least 6 characters.' };
  const key = u.toLowerCase();
  if (accounts[key]) return { error: 'That username is taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  accounts[key] = { username: u, salt, hash: hash(String(password), salt), displayName: u.slice(0, 12), flair: null, created: Date.now() };
  save();
  return { account: accounts[key] };
}

function login(username, password) {
  const a = accounts[String(username || '').trim().toLowerCase()];
  if (!a) return { error: 'Wrong username or password.' };
  const h = hash(String(password || ''), a.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(a.hash, 'hex'))) return { error: 'Wrong username or password.' };
  return { account: a };
}

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
  session.account = a;
  session.auth = true;
  session.name = a.displayName;
  session.flair = a.flair ? flairByKey[a.flair] || null : null;
  session.degree = 0;
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

module.exports = { register, login, bind, unbind, apply, setDisplayName, setFlair, flairs, flairByKey };
