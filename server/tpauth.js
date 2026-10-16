// tpauth.js - link a local account to a real TagPro account (tagpro.koalabeast.com). The player
// pastes their TagPro profile link and sets that account's flair to Pencil, then to no flair (and
// then back to whatever they had). Only the owner can change a TagPro flair, so seeing Pencil and
// then no flair proves the account is theirs.
// TagPro allows this server about 5 profile requests an hour (then blocks it for about an hour),
// so requests are shared: a player's Check queues them, and one request (/profiles/<id>,<id>,...)
// reads every player who is linking. At most MAX_PER_HOUR requests in any hour; after a 429 none
// until the block should be over. Both are saved so a restart doesn't run into the limit.
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');

const PENDING_MS = 3 * 60 * 60 * 1000; // long enough to wait for free requests
const MAX_PER_HOUR = 4;                // TagPro's limit is 5; one spare
const HOUR = 60 * 60 * 1000;
const GAP_MS = 5000;                   // between two requests
const BLOCK_MS = HOUR;                 // after a 429 with no Retry-After
const MAX_IDS = 40;                    // profiles per request
const CHALLENGE = 'degree.pencil';     // 2°: nearly everyone has it
const STEPS = [CHALLENGE, null];       // checked in this order; then "put your flair back"

// ---- request budget (saved in data/tagpro-limit.json) ----
const LIMIT_FILE = path.join(__dirname, '..', 'data', 'tagpro-limit.json');
const limit = (() => { try { const j = JSON.parse(fs.readFileSync(LIMIT_FILE, 'utf8')); return { sent: (j.sent || []).map(Number), blockedUntil: Number(j.blockedUntil) || 0 }; } catch (e) { return { sent: [], blockedUntil: 0 }; } })();
// a block saved by the previous version of this file still counts
try { limit.blockedUntil = Math.max(limit.blockedUntil, Number(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tagpro-block.json'), 'utf8')).until) || 0); } catch (e) { /* none */ }
function saveLimit() {
  try { fs.mkdirSync(path.dirname(LIMIT_FILE), { recursive: true }); fs.writeFileSync(LIMIT_FILE, JSON.stringify(limit)); } catch (e) { /* in memory still holds */ }
}
// when the next request may go out
function nextSlot() {
  const now = Date.now();
  limit.sent = limit.sent.filter((t) => now - t < HOUR);
  let at = Math.max(now, limit.blockedUntil, (limit.sent[limit.sent.length - 1] || 0) + GAP_MS);
  if (limit.sent.length >= MAX_PER_HOUR) at = Math.max(at, limit.sent[limit.sent.length - MAX_PER_HOUR] + HOUR);
  return at;
}

const fail = (msg) => { const e = new Error(msg); e.user = true; throw e; };
const none = (key) => key || null; // TagPro's "no flair" is ""
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

const pendingOf = (a) => (a && a.tagproPending && Date.now() - a.tagproPending.started < PENDING_MS && a.tagproPending.v === 2 ? a.tagproPending : null);
const linking = () => accounts.all().filter((a) => pendingOf(a));

// ---- the shared request ----
let timer = null, running = false;
function schedule() {
  clearTimeout(timer);
  if (!linking().some((a) => a.tagproPending.wants)) return;
  timer = setTimeout(run, Math.max(0, nextSlot() - Date.now()));
  timer.unref();
}

async function run() {
  if (running) return;
  if (nextSlot() > Date.now()) return schedule();
  const waiting = linking().filter((a) => a.tagproPending.wants);
  if (!waiting.length) return;
  // everyone linking rides along (they may have changed flair without clicking yet)
  const ids = [...new Set(waiting.concat(linking()).map((a) => a.tagproPending.id))].slice(0, MAX_IDS);
  running = true;
  limit.sent.push(Date.now()); saveLimit();
  let found = null, problem = null;
  try {
    const r = await fetch(`https://tagpro.koalabeast.com/profiles/${ids.join(',')}`, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after')) * 1000;
      limit.blockedUntil = Date.now() + (wait > 0 ? Math.min(wait, 2 * HOUR) : BLOCK_MS); saveLimit();
      problem = 'TagPro is limiting requests from this server.';
    } else if (!r.ok) problem = `TagPro answered with an error (${r.status}).`;
    else { const j = await r.json(); found = Object.fromEntries((Array.isArray(j) ? j : [j]).map((p) => [String(p._id).toLowerCase(), p])); }
  } catch (e) { problem = "Couldn't reach TagPro."; }
  running = false;
  for (const a of linking()) {
    if (!ids.includes(a.tagproPending.id)) continue;
    accounts.updateAccount(a.id, (acc) => {
      const pend = acc.tagproPending;
      pend.checked = Date.now();
      if (problem) { pend.problem = problem; return; }
      pend.problem = null; pend.wants = false;
      const p = found[pend.id];
      if (!p) { pend.problem = "TagPro didn't find that profile. Check the link."; return; }
      pend.name = p.reservedName || pend.name || null;
      pend.seen = none(p.selectedFlair);
      if (pend.seen === STEPS[pend.step]) pend.step++;
      if (pend.step >= STEPS.length) finishLink(acc);
    });
  }
  schedule();
}

function finishLink(acc) {
  const pend = acc.tagproPending;
  // one TagPro account links to one account here: proving it again moves it
  for (const other of accounts.withTagpro(pend.id)) if (other.id !== acc.id) accounts.updateAccount(other.id, (o) => { delete o.tagpro; });
  acc.tagpro = { id: pend.id, name: pend.name, linked: Date.now() };
  acc.justLinked = true;
  delete acc.tagproPending;
}

// ---- actions from the link page ----
function start(account, link) {
  const id = profileId(link);
  if (!id) fail('Paste your TagPro profile link, like https://tagpro.koalabeast.com/profile/60e8f6acf2eba8232c430731');
  accounts.updateAccount(account.id, (a) => { a.tagproPending = { v: 2, id, name: null, step: 0, wants: false, started: Date.now() }; });
}
// queue a look at TagPro (shared with everyone else linking)
function check(account) {
  const pend = pendingOf(account);
  if (!pend) fail('That took too long. Start again.');
  accounts.updateAccount(account.id, () => { pend.wants = true; });
  if (nextSlot() <= Date.now()) run(); else schedule();
}
function cancel(account) { accounts.updateAccount(account.id, (a) => { delete a.tagproPending; }); schedule(); }
function unlink(account) { accounts.updateAccount(account.id, (a) => { delete a.tagpro; delete a.tagproPending; }); }

// what the link page shows
function state(account) {
  const pend = pendingOf(account);
  const just = account.justLinked;
  if (just) accounts.updateAccount(account.id, (a) => { delete a.justLinked; });
  return {
    linked: account.tagpro ? { name: account.tagpro.name, url: profileUrl(account.tagpro.id), just: !!just } : null,
    pending: pend && {
      name: pend.name, url: profileUrl(pend.id), step: pend.step, steps: STEPS.map(flairInfo),
      seen: pend.seen === undefined ? null : flairInfo(pend.seen), wants: !!pend.wants, problem: pend.problem || null,
      nextCheck: pend.wants ? nextSlot() : null,
    },
    now: Date.now(),
  };
}

// after a restart: carry on with queued checks
setTimeout(schedule, 1000).unref();

module.exports = { start, check, cancel, unlink, state, profileId, profileUrl, flairInfo };
