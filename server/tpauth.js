// tpauth.js - link a local account to a real TagPro account (tagpro.koalabeast.com). The player
// pastes their TagPro profile link; we read that profile's public data (/profiles/<id>: name and
// selected flair) and ask them to set their TagPro flair to a low-degree one, then to no flair,
// then back to the one they had. Only the account's owner can change its flair, so seeing every
// change proves it. Lookups happen only while the player is on the link page (they click Check,
// or the page checks every 15 seconds); one lookup per 5 s for the whole server, and a pause
// after TagPro answers 429 (too many requests).
const accounts = require('./accounts');

const PENDING_MS = 30 * 60 * 1000;
const CHECK_GAP_MS = 3000;   // per account
const GLOBAL_GAP_MS = 5000;  // the whole server: TagPro answers 429 when we ask too often
const BACKOFF_MS = 60000;    // after a 429 with no Retry-After
let nextLookup = 0;          // no TagPro lookup before this time
// degree flairs nearly everyone has: 2°, 6°, 9°; the first one they aren't already wearing
const CHALLENGES = ['degree.pencil', 'degree.bacon', 'degree.baseball'];
const lastLookup = new Map(); // account id -> time

const fail = (msg) => { const e = new Error(msg); e.user = true; throw e; };
const none = (key) => key || null; // TagPro's "no flair": missing or empty
// a flair for the page: name, plus the sprite position when it's one we have the picture of
function flairInfo(key) {
  if (!key) return { key: null, name: 'No flair' };
  const f = accounts.flairByKey[key];
  if (!f) return { key, name: key };
  const deg = /(\d+)°/.exec(f.extra || '');
  return { key, name: f.description + (f.category === 'degree' && deg ? ` (${deg[1]}° degree flair)` : ''), className: f.className, x: f.x, y: f.y };
}
const profileUrl = (id) => `https://tagpro.koalabeast.com/profile/${id}`;

function profileId(text) {
  const m = /(?:^|\/|\s)([0-9a-f]{24})(?:$|[/?#\s])/i.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

async function lookup(account, id) {
  const now = Date.now(), last = lastLookup.get(account.id) || 0;
  if (now - last < CHECK_GAP_MS) fail('Wait a few seconds between checks.');
  if (now < nextLookup) fail(`TagPro is busy; trying again in ${Math.ceil((nextLookup - now) / 1000)} s.`);
  lastLookup.set(account.id, now);
  nextLookup = now + GLOBAL_GAP_MS;
  let p;
  try {
    const r = await fetch(`https://tagpro.koalabeast.com/profiles/${id}`, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after')) * 1000;
      nextLookup = Date.now() + (wait > 0 ? Math.min(wait, 10 * 60000) : BACKOFF_MS);
      fail(`TagPro is limiting lookups right now; trying again in ${Math.ceil((nextLookup - Date.now()) / 1000)} s. Your progress is kept.`);
    }
    if (r.status === 404) fail("TagPro didn't find that profile.");
    if (!r.ok) fail(`TagPro answered with an error (${r.status}). Try again in a minute.`);
    const j = await r.json();
    p = Array.isArray(j) ? j[0] : j;
  } catch (e) {
    if (e.user) throw e;
    fail("Couldn't reach TagPro to read the profile. Try again in a minute.");
  }
  if (!p || String(p._id).toLowerCase() !== id) fail("TagPro didn't find that profile.");
  return { name: p.reservedName || null, flair: none(p.selectedFlair) };
}

const pendingOf = (a) => (a.tagproPending && Date.now() - a.tagproPending.started < PENDING_MS && Array.isArray(a.tagproPending.steps) ? a.tagproPending : null);

// the flairs to set, in order: a low-degree one, no flair, then the original (a step that would
// repeat the one before it is dropped, e.g. for someone with no flair to begin with)
function stepsFor(original) {
  const challenge = CHALLENGES.find((k) => k !== original);
  return [challenge, null, original].filter((k, i, a) => i === 0 || k !== a[i - 1]);
}

async function start(account, link) {
  const id = profileId(link);
  if (!id) fail('Paste your TagPro profile link, like https://tagpro.koalabeast.com/profile/60e8f6acf2eba8232c430731');
  const p = await lookup(account, id);
  accounts.updateAccount(account.id, (a) => { a.tagproPending = { id, name: p.name, original: p.flair, steps: stepsFor(p.flair), step: 0, started: Date.now() }; });
}

// returns { done, now: flair TagPro shows } ; moves on as many steps as the current flair allows
async function check(account) {
  const pend = pendingOf(account);
  if (!pend) fail('That took too long. Start again.');
  const p = await lookup(account, pend.id);
  if (p.flair !== pend.steps[pend.step]) return { done: false, now: flairInfo(p.flair) };
  accounts.updateAccount(account.id, () => { pend.step++; });
  if (pend.step < pend.steps.length) return { done: false, now: flairInfo(p.flair) };
  // one TagPro account links to one account here: proving it again moves it
  for (const other of accounts.withTagpro(pend.id)) if (other.id !== account.id) accounts.updateAccount(other.id, (a) => { delete a.tagpro; });
  accounts.updateAccount(account.id, (a) => { a.tagpro = { id: pend.id, name: p.name, linked: Date.now() }; delete a.tagproPending; });
  return { done: true, now: flairInfo(p.flair) };
}

function cancel(account) { accounts.updateAccount(account.id, (a) => { delete a.tagproPending; }); }
function unlink(account) { accounts.updateAccount(account.id, (a) => { delete a.tagpro; delete a.tagproPending; }); }

// what the link page shows
function state(account) {
  const pend = pendingOf(account);
  return {
    linked: account.tagpro ? { name: account.tagpro.name, url: profileUrl(account.tagpro.id) } : null,
    pending: pend && { name: pend.name, url: profileUrl(pend.id), step: pend.step, steps: pend.steps.map(flairInfo), original: flairInfo(pend.original), expires: pend.started + PENDING_MS },
  };
}

module.exports = { start, check, cancel, unlink, state, profileId, profileUrl, flairInfo };
