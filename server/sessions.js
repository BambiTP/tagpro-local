// sessions.js - guest sessions keyed by the "tpid" cookie, like tagpro.koalabeast.com.
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
      name: 'Some Ball',   // unregistered display name, as on the real site
      auth: null,
      flair: null,
      groupId: null,       // group this session belongs to
      pendingGame: null,   // game id the joiner sent this session to
      spectate: false,
    };
    sessions.set(id, s);
  }
  return s;
}

// Express middleware: ensure a tpid cookie and attach req.session
function middleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies.tpid;
  if (!id || id.length < 16) {
    id = newId();
    res.setHeader('Set-Cookie', `tpid=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365 * 10}; SameSite=Lax`);
  }
  req.session = get(id);
  (accounts || (accounts = require('./accounts'))).apply(req.session);
  next();
}

// For socket.io handshakes
function fromSocket(socket) {
  const s = get(parseCookies(socket.handshake.headers.cookie).tpid);
  if (s) (accounts || (accounts = require('./accounts'))).apply(s);
  return s;
}

module.exports = { get, middleware, fromSocket, newId, parseCookies };
