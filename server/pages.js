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
    if (part === '<!--norebrand-->') { rawUntil = '<!--/norebrand-->'; return part; } // about the real TagPro: keep its name
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
const DEAD_LINKS = ['/donate'];
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

// linked real TagPro account (server/tpauth.js; linking happens on /tagpro-link)
function tagproSection(account) {
  const t = account.tagpro;
  return `<!--norebrand--><h2 id="tagpro">TagPro account</h2>
    ${t ? `<p>Linked to <a href="https://tagpro.koalabeast.com/profile/${esc(t.id)}" target="_blank" rel="noopener"><b>${esc(t.name || 'your TagPro account')}</b></a> <span class="label label-success">verified</span> <a class="btn btn-default btn-sm" href="/tagpro-link">Change</a></p>`
    : '<p><a class="btn btn-primary" href="/tagpro-link">Link your TagPro account</a></p>'}<!--/norebrand-->`;
}

// /tagpro-link: the whole linking flow on one page. Checks are shared and rationed (tpauth.js), so
// after Check the page asks this server every 10 s how it went. Not renamed to BambiPro: it's
// about the real TagPro.
function tagproLinkCard(state, back) {
  const data = JSON.stringify({ state, back }).replace(/</g, '\\u003c');
  return `<!--norebrand--><div class="profile" id="tp-link"><h1>Link your TagPro account</h1>
    <div id="tp-body"></div></div><!--/norebrand-->
    <script>(function () {
      var D = ${data}, S = D.state, skew = S.now - Date.now(), busy = false, poll = null, msg = '', err = '';
      var body = document.getElementById('tp-body');
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function icon(f) {
        if (f.className) return '<span class="flair ' + esc(f.className) + '" style="--flair-col: ' + f.x + '; --flair-row: ' + f.y + '; display:inline-block; vertical-align:middle"></span>';
        return '<span style="display:inline-block;width:16px;height:16px;border:1px dashed #888;vertical-align:middle"></span>';
      }
      function when(t) { var s = Math.max(0, Math.round((t - Date.now() - skew) / 1000)); return s < 5 ? 'now' : s < 90 ? 'in ' + s + ' s' : 'in about ' + Math.ceil(s / 60) + ' min'; }
      function got(j) { S = j.state; skew = S.now - Date.now(); err = j.error || ''; if (j.message) msg = j.message; render(); }
      function post(fields) {
        if (busy) return;
        busy = true;
        fetch('/tagpro-link', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
          .then(function (r) { return r.json(); }).then(got).catch(function () { err = "Couldn't reach the server."; render(); })
          .then(function () { busy = false; });
      }
      function render() {
        clearTimeout(poll);
        var out = (msg ? '<div class="alert alert-success">' + esc(msg) + '</div>' : '') + (err ? '<div class="alert alert-danger">' + esc(err) + '</div>' : '');
        if (S.linked) {
          out += '<p>Linked to <a href="' + esc(S.linked.url) + '" target="_blank" rel="noopener"><b>' + esc(S.linked.name || 'your TagPro account') + '</b></a> <span class="label label-success">verified</span></p>';
          if (S.linked.just) out += '<p>You can put your old flair back on TagPro now.</p>';
          if (D.back) out += '<p><a class="btn btn-success" href="' + esc(D.back.url) + '">Back to ' + esc(D.back.name) + ' to sign up</a></p>';
          out += '<p><button class="btn btn-default btn-sm" data-a="unlink">Unlink</button> <a class="btn btn-default btn-sm" href="/profile">Profile</a></p>';
        } else if (S.pending) {
          var P = S.pending;
          out += '<p>On <a href="https://tagpro.koalabeast.com/profile" target="_blank" rel="noopener">tagpro.koalabeast.com/profile</a>' + (P.name ? ' (<a href="' + esc(P.url) + '" target="_blank" rel="noopener">' + esc(P.name) + '</a>)' : '') + ', set your flair to:</p><ol style="font-size:16px">';
          P.steps.forEach(function (f, i) {
            var st = i < P.step ? ' <span style="color:#8BC34A">&#10003;</span>' : i === P.step ? ' <b>&larr; now, then Check</b>' : '';
            out += '<li style="margin:6px 0' + (i > P.step ? ';opacity:.5' : '') + '">' + icon(f) + ' ' + esc(f.name) + st + '</li>';
          });
          out += '<li style="margin:6px 0;opacity:.5">Your old flair again (not checked)</li></ol>';
          if (P.seen) out += '<p style="opacity:.8">TagPro last showed: ' + icon(P.seen) + ' ' + esc(P.seen.name) + '</p>';
          if (P.problem) out += '<div class="alert alert-warning">' + esc(P.problem) + '</div>';
          if (P.wants) {
            out += '<p><b>Checking TagPro ' + when(P.nextCheck) + '.</b> <span style="opacity:.6">TagPro only allows a few checks an hour, so they are shared.</span></p>';
            poll = setTimeout(function () { fetch('/tagpro-link/state').then(function (r) { return r.json(); }).then(got).catch(render); }, 10000);
          } else out += '<p><button class="btn btn-primary" data-a="check">Check</button> <button class="btn btn-default" data-a="cancel">Cancel</button></p>';
        } else {
          out += '<p>Your TagPro profile link (open your profile on <a href="https://tagpro.koalabeast.com/profile" target="_blank" rel="noopener">tagpro.koalabeast.com</a> and copy the address):</p>'
            + '<form id="tp-start" class="form-inline"><input class="form-control" name="link" placeholder="https://tagpro.koalabeast.com/profile/..." style="min-width:340px" required> <button class="btn btn-primary" type="submit">Start</button></form>';
        }
        body.innerHTML = out;
        var f = document.getElementById('tp-start');
        if (f) f.addEventListener('submit', function (e) { e.preventDefault(); msg = ''; post({ action: 'start', link: f.link.value }); });
      }
      body.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-a');
        if (!a) return;
        msg = ''; err = '';
        post({ action: a });
      });
      render();
    })();</script>`;
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
                        ${tagproSection(account)}
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

module.exports = { tagproLinkCard, leadersCard, render, esc, groupItem, setStatsProvider, loginCard, profileCard, statsTable };
