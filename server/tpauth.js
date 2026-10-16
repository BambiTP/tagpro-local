// tpauth.js - link a local account to a real TagPro account (tagpro.koalabeast.com). The player
// pastes their TagPro profile link; we read that profile's public data (/profiles/<id>: name and
// selected flair), ask them to switch their TagPro flair to a low-degree one, then back to the one
// they had. Only the account's owner can change its flair, so seeing both changes proves it.
// Lookups happen only when the player clicks, at most one per account every few seconds.
const accounts = require('./accounts');

const PENDING_MS = 30 * 60 * 1000;
const CHECK_GAP_MS = 3000;
// degree flairs nearly everyone has: 2°, 6°, 9°; the first one they aren't already wearing
const CHALLENGES = ['degree.pencil', 'degree.bacon', 'degree.baseball'];
const lastLookup = new Map(); // account id -> time

const fail = (msg) => { const e = new Error(msg); e.user = true; throw e; };
function flairName(key) {
  if (!key) return 'no flair';
  const f = accounts.flairByKey[key];
  if (!f) return key;
  const deg = /(\d+)°/.exec(f.extra || '');
  return f.description + (f.category === 'degree' && deg ? ` (the ${deg[1]}° degree flair)` : '');
}
const profileUrl = (id) => `https://tagpro.koalabeast.com/profile/${id}`;

function profileId(text) {
  const m = /(?:^|\/|\s)([0-9a-f]{24})(?:$|[/?#\s])/i.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

async function lookup(account, id) {
  const now = Date.now(), last = lastLookup.get(account.id) || 0;
  if (now - last < CHECK_GAP_MS) fail('Wait a few seconds between checks.');
  lastLookup.set(account.id, now);
  let p;
  try {
    const r = await fetch(`https://tagpro.koalabeast.com/profiles/${id}`, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
    if (!r.ok) fail("TagPro didn't find that profile.");
    const j = await r.json();
    p = Array.isArray(j) ? j[0] : j;
  } catch (e) {
    if (e.user) throw e;
    fail("Couldn't reach TagPro to read the profile. Try again in a minute.");
  }
  if (!p || String(p._id).toLowerCase() !== id) fail("TagPro didn't find that profile.");
  return { name: p.reservedName || null, flair: p.selectedFlair || null };
}

const pendingOf = (a) => (a.tagproPending && Date.now() - a.tagproPending.started < PENDING_MS ? a.tagproPending : null);

async function start(account, link) {
  const id = profileId(link);
  if (!id) fail('Paste your TagPro profile link, like https://tagpro.koalabeast.com/profile/60e8f6acf2eba8232c430731');
  const p = await lookup(account, id);
  const challenge = CHALLENGES.find((k) => k !== p.flair);
  accounts.updateAccount(account.id, (a) => { a.tagproPending = { id, name: p.name, original: p.flair, challenge, step: 1, started: Date.now() }; });
}

// returns a message for the player
async function check(account) {
  const pend = pendingOf(account);
  if (!pend) fail('Start again: paste your TagPro profile link.');
  const p = await lookup(account, pend.id);
  if (pend.step === 1) {
    if (p.flair !== pend.challenge) fail(`TagPro still shows ${flairName(p.flair)}. Select ${flairName(pend.challenge)} on your TagPro profile, then check again.`);
    accounts.updateAccount(account.id, () => { pend.step = 2; });
    return `Got it. Now change your TagPro flair back to ${flairName(pend.original)}.`;
  }
  if (p.flair !== pend.original) fail(`TagPro still shows ${flairName(p.flair)}. Change it back to ${flairName(pend.original)}, then check again.`);
  // one TagPro account links to one account here: proving it again moves it
  for (const other of accounts.withTagpro(pend.id)) if (other.id !== account.id) accounts.updateAccount(other.id, (a) => { delete a.tagpro; });
  accounts.updateAccount(account.id, (a) => { a.tagpro = { id: pend.id, name: p.name, linked: Date.now() }; delete a.tagproPending; });
  return `Linked to TagPro account ${p.name || pend.id}.`;
}

function cancel(account) { accounts.updateAccount(account.id, (a) => { delete a.tagproPending; }); }
function unlink(account) { accounts.updateAccount(account.id, (a) => { delete a.tagpro; delete a.tagproPending; }); }

// what the profile page shows
function state(account) {
  const pend = pendingOf(account);
  return {
    linked: account.tagpro ? { ...account.tagpro, url: profileUrl(account.tagpro.id) } : null,
    pending: pend && { step: pend.step, name: pend.name, url: profileUrl(pend.id), challenge: flairName(pend.challenge), original: flairName(pend.original) },
  };
}

module.exports = { start, check, cancel, unlink, state, profileId, profileUrl };
