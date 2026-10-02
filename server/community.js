// community.js - feedback threads, player search and public profiles (local pages, not copies
// of the real ones). Feedback is stored in data/feedback.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { esc, statsTable } = require('./pages');

const FILE = path.join(__dirname, '..', 'data', 'feedback.json');
let threads = [];
try { threads = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { threads = []; }
function save() { fs.writeFileSync(FILE + '.tmp', JSON.stringify(threads)); fs.renameSync(FILE + '.tmp', FILE); }

const lastPost = new Map(); // account id -> time (simple flood protection)
const MAX_BODY = 4000;

function author(account) {
  return { id: account.id, username: account.username, displayName: account.displayName, flair: account.flair || null };
}

function canPost(account) {
  const t = lastPost.get(account.id) || 0;
  if (Date.now() - t < 15000) return 'Please wait a few seconds before posting again.';
  return null;
}

function createThread(account, body) {
  body = String(body || '').trim().slice(0, MAX_BODY);
  if (!body) return { error: 'Write something first.' };
  const err = canPost(account); if (err) return { error: err };
  lastPost.set(account.id, Date.now());
  const t = { id: crypto.randomBytes(6).toString('hex'), author: author(account), body, created: Date.now(), updated: Date.now(), replies: [] };
  threads.unshift(t); save();
  return { thread: t };
}

function reply(account, id, body) {
  const t = threads.find((x) => x.id === id);
  if (!t) return { error: 'Thread not found.' };
  body = String(body || '').trim().slice(0, MAX_BODY);
  if (!body) return { error: 'Write something first.' };
  const err = canPost(account); if (err) return { error: err };
  lastPost.set(account.id, Date.now());
  t.replies.push({ author: author(account), body, created: Date.now() });
  t.updated = Date.now(); save();
  return { thread: t };
}

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const text = (s) => esc(s).replace(/\n/g, '<br>');
const who = (a) => `<a href="/profile/${esc(a.id)}"><b>${esc(a.displayName)}</b></a>`;

function feedbackCard(account, error) {
  const form = account
    ? `<form method="post" action="/feedback">
         <textarea class="form-control" name="body" rows="4" maxlength="${MAX_BODY}" placeholder="Bug report, idea, anything..." required></textarea>
         <div class="text-center" style="margin-top:10px"><button class="btn btn-primary" type="submit">Post</button></div>
       </form>`
    : `<p><a class="btn btn-primary" href="/login">Log in</a> to post feedback.</p>`;
  const list = threads.slice().sort((a, b) => b.updated - a.updated).map((t) => `
       <a href="/feedback/${t.id}" style="display:block;padding:10px 0;border-top:1px solid #444;color:inherit;text-decoration:none">
         <div>${esc(t.body.split('\n')[0].slice(0, 120))}${t.body.length > 120 || t.body.includes('\n') ? '…' : ''}</div>
         <small style="opacity:.7">${esc(t.author.displayName)} · ${when(t.created)} · ${t.replies.length} ${t.replies.length === 1 ? 'reply' : 'replies'}</small>
       </a>`).join('') || '<p style="opacity:.7">No feedback yet.</p>';
  return `<h1>Feedback</h1>${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}${form}<hr><h3>Threads</h3>${list}`;
}

function threadCard(id, account, error) {
  const t = threads.find((x) => x.id === id);
  if (!t) return null;
  const post = (a, body, created) => `<div style="padding:10px 0;border-top:1px solid #444"><div>${who(a)} <small style="opacity:.7">${when(created)}</small></div><div style="margin-top:6px">${text(body)}</div></div>`;
  const form = account
    ? `<form method="post" action="/feedback/${t.id}/reply" style="margin-top:12px">
         <textarea class="form-control" name="body" rows="3" maxlength="${MAX_BODY}" placeholder="Reply..." required></textarea>
         <div class="text-center" style="margin-top:10px"><button class="btn btn-primary" type="submit">Reply</button></div>
       </form>`
    : `<p style="margin-top:12px"><a href="/login">Log in</a> to reply.</p>`;
  return `<p><a href="/feedback">&larr; All feedback</a></p>${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}${post(t.author, t.body, t.created)}${t.replies.map((r) => post(r.author, r.body, r.created)).join('')}${form}`;
}

// ---- player search / public profiles ----
const flairSpan = (f) => f ? `<span class="flair ${esc(f.className)}" style="--flair-col: ${f.x}; --flair-row: ${f.y}; display:inline-block; vertical-align:middle;"></span> ` : '';

function searchCard(q, results) {
  const rows = results.map((a) => `<div style="padding:8px 0;border-top:1px solid #444"><div class="profile" style="display:inline">${flairSpan(a.flairObj)}</div><a href="/profile/${esc(a.id)}"><b>${esc(a.displayName)}</b></a> <small style="opacity:.7">${esc(a.username)}</small></div>`).join('');
  return `<h1>Player Search</h1>
    <form method="get" action="/playersearch"><div class="input-group">
      <input class="form-control" name="q" value="${esc(q || '')}" placeholder="Name" autofocus>
      <span class="input-group-btn"><button class="btn btn-primary" type="submit">Search</button></span>
    </div></form>
    ${q != null ? `<div style="margin-top:12px">${rows || '<p style="opacity:.7">No players found.</p>'}</div>` : ''}`;
}

function publicProfileCard(a, flairObj, games) {
  const rows = games.map((g) => {
    const me = g.players.find((p) => p.userId === a.id);
    const team = me ? (me.team === 1 ? 'red' : 'blue') : null;
    const won = me && g.winner === me.team;
    const key = Buffer.from(g.id + a.id, 'hex').toString('base64').replace(/\+/g, '_');
    return `<tr><td>${esc(g.started.slice(0, 16).replace('T', ' '))}</td><td>${esc(g.mapName)}</td>
      <td class="${team || 'no'}-team-text">${team ? esc(g.teams[team].name) : ''}</td>
      <td>${g.teams.red.score} - ${g.teams.blue.score}${won ? ' <i class="fa fa-trophy"></i>' : ''}</td>
      <td><a href="/game?replay=${key}" target="_blank">Watch</a></td></tr>`;
  }).join('');
  return `<div class="profile"><h1>${flairSpan(flairObj)}${esc(a.displayName)}</h1>
    <p style="opacity:.7">${esc(a.username)} · joined ${when(a.created).slice(0, 10)}</p>
    ${statsTable(a)}
    <h3>Recent Games</h3>
    ${rows ? `<table class="table"><thead><tr><th>Date</th><th>Map</th><th>Team</th><th>Score</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p style="opacity:.7">No games yet.</p>'}</div>`;
}

module.exports = { createThread, reply, feedbackCard, threadCard, searchCard, publicProfileCard };
