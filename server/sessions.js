// sessions.js - guest sessions keyed by the "tpid" cookie, like tagpro.koalabeast.com.
// The cookie value is a secret (it is the login): other players only ever see session.publicId.
const crypto = require('crypto');

const sessions = new Map(); // tpid -> session
let accounts = null; // set lazily (accounts.js) to apply logged-in name/flair

function newId(len = 32) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += abc[bytes[i] & 63];
  return s;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function get(id) {
  if (!id) return null;
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      publicId: newId(16),  // what other players see (group member id, game sessionId)
      name: 'Some Ball',   // unregistered display name, as on the real site
      auth: null,
      flair: null,
      groupId: null,       // group this session belongs to
      pendingGame: null,   // game id the joiner sent this session to
      spectate: false,
    };
    sessions.set(id, s);
  }
  s.lastSeen = Date.now();
  return s;
}

// guest sessions idle for a day are dropped (otherwise every cookie-less request is kept forever);
// a logged-in cookie still works afterwards (accounts.js keeps those)
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff && !s.groupId) sessions.delete(id);
}, 3600 * 1000).unref();

const https = (req) => (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
function setCookie(req, res, id) {
  res.setHeader('Set-Cookie', `tpid=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365 * 10}; SameSite=Lax; HttpOnly${https(req) ? '; Secure' : ''}`);
}

// Express middleware: ensure a tpid cookie and attach req.session. Only ids this server issued are
// accepted, so another site can't plant a known one (session fixation).
function middleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies.tpid;
  if (!id || !sessions.has(id) && !(accounts || (accounts = require('./accounts'))).knownSession(id)) {
    id = newId();
    setCookie(req, res, id);
  }
  req.session = get(id);
  (accounts || (accounts = require('./accounts'))).apply(req.session);
  next();
}

// a fresh cookie for this session, e.g. on log in, so an id seen before then is worthless
function rotate(req, res) {
  const s = req.session, id = newId();
  sessions.delete(s.id);
  s.id = id;
  sessions.set(id, s);
  setCookie(req, res, id);
  return s;
}

// For socket.io handshakes: only sessions this server already knows (the page load made them)
function fromSocket(socket) {
  const id = parseCookies(socket.handshake.headers.cookie).tpid;
  const s = id && sessions.has(id) ? sessions.get(id) : null;
  if (s) s.lastSeen = Date.now();
  if (s) (accounts || (accounts = require('./accounts'))).apply(s);
  return s;
}

module.exports = { get, middleware, fromSocket, rotate, newId, parseCookies };
