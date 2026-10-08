// pages.js - renders the real TagPro page templates (built by tools/build-pages.py).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'pages');
const cache = {};
function tpl(name) {
  // re-read in dev so template rebuilds show up without a restart
  const file = path.join(dir, name);
  const mtime = fs.statSync(file).mtimeMs;
  if (!cache[name] || cache[name].mtime !== mtime) cache[name] = { mtime, text: fs.readFileSync(file, 'utf8') };
  return cache[name].text;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let statsProvider = () => ({});
function setStatsProvider(fn) { statsProvider = fn; }

// ---- branding: visible "TagPro" -> crossed-out "Tag" + "Bambi" (titles/alt text: plain BambiPro)
// only the game's name: whole word, not the TagPro powerup ("Powerup: TagPro", "Kissing TagPros",
// "TagPro Max Tags", "TagPro Duration", "TagPro powerup")
const BRAND_RE = /(?<!powerup:\s*)\b(tag)(pro)\b(?!s\b|\s+(?:powerup|max tags|duration))/gi;
const bambi = (tag) => (tag === tag.toUpperCase() ? 'BAMBI' : tag[0] === 'T' ? 'Bambi' : 'bambi');
function rebrand(html) {
  const plain = (t) => t.replace(BRAND_RE, (m, tag, pro) => bambi(tag) + pro);
  // inside <option>/<textarea> markup can't render: plain text, and an option without a value
  // attribute is left alone (its text is its value, e.g. map names like "GASBOP TagPro Map")
  let inOption = null, rawUntil = null;
  return html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<title>[\s\S]*?<\/title>|<textarea[\s\S]*?<\/textarea>|<[^>]+>)/i).map((part) => {
    if (rawUntil) { if (part.toLowerCase().startsWith(rawUntil)) rawUntil = null; return part; }
    if (/^<(title|textarea)/i.test(part)) return plain(part);
    if (/^<div\b[^>]*id="texture-pack-data"/i.test(part)) { rawUntil = '</div'; return part; } // JSON data, not text
    if (part.startsWith('<')) {
      if (/^<option\b/i.test(part)) inOption = /\bvalue=/i.test(part) ? 'plain' : 'keep';
      else if (/^<\/(option|select)/i.test(part)) inOption = null;
      // alt text and link-preview tags (og:*, twitter:*, description) can't show markup: plain BambiPro
      if (/^<meta\b/i.test(part)) return part.replace(/(\bcontent=")([^"]*)(")/i, (m, a, v, b) => a + plain(v) + b);
      return part.replace(/(\balt=")([^"]*)(")/gi, (m, a, v, b) => a + plain(v) + b);
    }
    if (inOption === 'keep') return part;
    if (inOption === 'plain') return plain(part);
    return part.replace(BRAND_RE, (m, tag, pro) => `<s>${tag}</s>${bambi(tag)}${pro}`);
  }).join('');
}

// pages that don't exist on this server: shown greyed out and unclickable
const DEAD_LINKS = ['/competitive', '/donate'];
function disableDeadLinks(html) {
  return html.replace(/<a\b([^>]*?)\bhref="([^"]*)"([^>]*)>/gi, (m, pre, href, post) =>
    DEAD_LINKS.includes(href) ? `<a${pre}${post} aria-disabled="true" style="pointer-events:none;opacity:.4;cursor:default">` : m);
}

// the saved real pages report every visit to TagPro's own Reddit ad account: never sent from here
const REDDIT_PIXEL = /<script>\s*!function \(w, d\) \{\s*if \(w\.rdt\) return;[\s\S]*?<\/script>/g;

function render(name, vars = {}) {
  vars = Object.assign({}, statsProvider(), vars);
  let html = tpl(name).replace(REDDIT_PIXEL, '').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
  html = disableDeadLinks(rebrand(html));
  // redrawn images: version the URLs so cached copies of the old ones aren't shown
  html = html.replace(/\/images\/(logo|KoalaBeast)\.png(?=")/g, '/images/$1.png?v=bambi1');
  // link previews (Discord etc.) need absolute URLs pointing at this site
  if (vars.ORIGIN) {
    html = html.replace(/(<meta property="og:url" content=")[^"]*(")/i, `$1${vars.ORIGIN}/$2`)
      .replace(/(<meta property="og:image" content=")\/(?!\/)([^"]*")/i, `$1${vars.ORIGIN}/$2`);
  }
  if (vars.USER_NAME) {
    // logged in: the header's "Log In / Sign Up" becomes the player's name (links to the profile)
    html = html.replace('<a id="login-btn" class="btn btn-secondary" href="/login">Log In / Sign Up</a>', `<a id="login-btn" class="btn btn-secondary" href="/profile">${esc(vars.USER_NAME)}</a>`)
      .replace('<li class="nav-mobile"><a href="/login">Log In / Sign Up</a></li>', `<li class="nav-mobile"><a href="/profile">${esc(vars.USER_NAME)}</a></li>`);
  }
  return html;
}

// public-game stats (Play Now) + degree progress, shown on profiles
function statsTable(account) {
  const A = require('./accounts');
  const st = Object.assign(A.emptyStats(), account.stats || {});
  const deg = A.degreeFor(st.wins), next = A.winsForDegree(deg + 1);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0) + '%';
  const hms = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const per = (n) => (st.games ? (n / st.games).toFixed(2) : '0.00');
  const rows = [
    ['Degree', `${deg}&deg;`, deg < 360 ? `${next - st.wins} more ${next - st.wins === 1 ? 'win' : 'wins'} to ${deg + 1}&deg;` : ''],
    ['Games', st.games, ''], ['Wins', st.wins, pct(st.wins, st.games)], ['Losses', st.losses, ''], ['Ties', st.ties, ''],
    ['Time Played', hms(st.timePlayed), ''],
    ['Captures', st.captures, per(st.captures) + ' / game'], ['Grabs', st.grabs, per(st.grabs) + ' / game'],
    ['Hold', hms(st.hold * 1000), ''], ['Tags', st.tags, per(st.tags) + ' / game'], ['Pops', st.pops, per(st.pops) + ' / game'],
    ['Returns', st.returns, per(st.returns) + ' / game'], ['Prevent', hms(st.prevent * 1000), ''],
    ['Support', st.support, ''], ['Powerups', st.powerups, per(st.powerups) + ' / game'],
  ];
  return `<h3>Public Game Stats</h3><p style="opacity:.7;margin-top:-6px">Play Now games</p>
    <table class="table table-condensed"><tbody>${rows.map(([k, v, x]) => `<tr><td>${k}</td><td class="text-right"><b>${v}</b></td><td class="text-right" style="opacity:.7">${x}</td></tr>`).join('')}</tbody></table>${rankedTable(account)}`;
}

// Eggball Ranked (server/ranked.js), shown once the account has played a ranked game
function rankedTable(account) {
  const r = require('./accounts').rankedOf(account);
  if (!r.games) return '';
  const rows = [['Rating', r.rating], ['Games', r.games], ['Wins', r.wins], ['Losses', r.losses], ['Ties', r.ties], ['Games left early', r.leaves]];
  return `<h3>Eggball Ranked</h3>
    <table class="table table-condensed"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="text-right"><b>${v}</b></td></tr>`).join('')}</tbody></table>`;
}

function leadersCard(board) {
  const rows = board.map((r, i) => `<tr><td>${i + 1}</td><td><a href="/profile/${esc(r.account.id)}">${esc(r.account.displayName)}</a></td><td class="text-right"><b>${r.rating}</b></td><td class="text-right">${r.wins}-${r.losses}-${r.ties}</td><td class="text-right">${r.games}</td></tr>`).join('');
  return `<h1>Leaders</h1><h3>Eggball Ranked</h3><p style="opacity:.7;margin-top:-6px">Elo rating, everyone starts at 1500. <a href="/games/find?type=ranked">Play Eggball Ranked</a></p>
    <table class="table table-condensed"><thead><tr><th>#</th><th>Player</th><th class="text-right">Rating</th><th class="text-right">W-L-T</th><th class="text-right">Games</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="opacity:.7">No ranked games yet.</td></tr>'}</tbody></table>`;
}

function loginCard(error, tab) {
  const field = (label, name, type, extra = '') => `
                            <div class="form-group">
                                <label class="col-sm-4 control-label" for="${name}">${label}</label>
                                <div class="col-sm-8"><input class="form-control" id="${name}" name="${name}" type="${type}" ${extra}></div>
                            </div>`;
  return `
                        <h1>Log In</h1>
                        ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
                        <form class="form form-horizontal" action="/login" method="post">${field('Username', 'username', 'text', 'maxlength="16" autocomplete="username" required')}${field('Password', 'password', 'password', 'autocomplete="current-password" required')}
                            <div class="form-group"><div class="col-sm-12 text-center"><button class="btn btn-primary" type="submit">Log In</button></div></div>
                        </form>
                        <hr>
                        <h1>Create Account</h1>
                        <form class="form form-horizontal" action="/register" method="post">${field('Username', 'username', 'text', 'maxlength="16" autocomplete="username" required')}${field('Password', 'password', 'password', 'minlength="6" autocomplete="new-password" required')}
                            <div class="form-group"><div class="col-sm-12 text-center"><button class="btn btn-default" type="submit">Create Account</button></div></div>
                        </form>`;
}

function profileCard(account, flairs) {
  const items = [{ key: '', className: '', x: -1, y: -1, description: 'No Flair', extra: 'Remove your flair', category: '' }].concat(flairs).map((f) => `
                                <li class="otherFlair">
                                    <div class="flair-item flair-available${(account.flair || '') === f.key ? ' selected' : ''}" data-flair="${esc(f.key)}">
                                        ${f.key ? `<span class="flair ${esc(f.className)}" style="--flair-col: ${f.x}; --flair-row: ${f.y};"></span>` : '<span class="flair" style="display:inline-block;width:16px;height:16px;border:1px dashed #888;"></span>'}
                                        <div class="flair-tooltip">
                                            <div class="flair-header">${esc(f.description)}</div>
                                            <div class="flair-description">${esc(f.extra || '')}</div>
                                            <div class="flair-footer"><div class="flair-type">${esc(f.category)}</div></div>
                                        </div>
                                    </div>
                                </li>`).join('');
  return `<div class="profile">
                        <h1>${esc(account.displayName)}</h1>
                        <form class="form form-horizontal" action="/profile" method="post">
                            <div class="form-group">
                                <label class="col-sm-4 control-label" for="reservedName">Username</label>
                                <div class="col-sm-8"><input class="form-control" id="reservedName" name="reservedName" type="text" value="${esc(account.username)}" disabled></div>
                            </div>
                            <div class="form-group">
                                <label class="col-sm-4 control-label" for="displayedName">Display Name</label>
                                <div class="col-sm-8"><input class="form-control" id="displayedName" name="displayedName" type="text" maxlength="12" value="${esc(account.displayName)}"></div>
                            </div>
                            <div class="form-group">
                                <div class="col-sm-12 text-center">
                                    <div class="form-status" style="margin-bottom: 10px;"></div>
                                    <button id="saveSettings" class="btn btn-primary" type="submit">Save</button>
                                    <a class="btn btn-default" href="/logout">Log Out</a>
                                </div>
                            </div>
                        </form>
                        <hr>
                        ${statsTable(account)}
                        <hr>
                        <h2>Flair</h2>
                        <p>Click a flair to wear it.</p>
                        <div class="profile-flair block">
                            <div class="tab-content">
                                <div class="tab-pane active" id="flair">
                                    <ul class="flair-list js-flair-owner">${items}
                                    </ul>
                                </div>
                            </div>
                        </div></div>`;
}

function groupItem(g) {
  const members = g.memberList();
  const leader = members.find((m) => m.leader);
  return `
                        <div class="col-md-6">
                            <div class="group-item">
                                <div class="row">
                                    <div class="col-md-12">
                                        <div class="pull-right group-type">
                                            ${g.settings.server === 'p2p' ? '<b style="color:#f39c12" title="Games run on a player\'s own PC, not the Chicago server">&#9888; PEER TO PEER</b> &middot; ' : ''}${g.settings.isPrivate ? 'Private Games' : 'Public Games'}
                                        </div>
                                        <div class="group-name">
                                            ${esc(g.settings.name)}
                                        </div>
                                    </div>
                                    <div class="col-xs-6">
                                        <div class="">
                                            Leader: ${esc(leader ? leader.name : '')}
                                        </div>
                                        <div class="showMemberList">
                                            Players: ${members.length}
                                        </div>
                                        <div class="memberList">
                                            <div>
                                                Member List:
                                            </div>
${members.map((m) => `                                            <div class="groupMember${m.auth ? ' auth' : ''}">${esc(m.name)}</div>`).join('\n')}
                                        </div>
                                        <div class="">
                                        </div>
                                    </div>
                                    <div class="col-xs-6">
                                        <a class="btn btn-primary pull-right" href="/groups/${g.id}">
                                            Join Group
                                        </a>
                                    </div>
                                </div>
                            </div>
                        </div>`;
}

module.exports = { leadersCard, render, esc, groupItem, setStatsProvider, loginCard, profileCard, statsTable };
