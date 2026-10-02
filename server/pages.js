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

function render(name, vars = {}) {
  vars = Object.assign({}, statsProvider(), vars);
  let html = tpl(name).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (vars.USER_NAME) {
    // logged in: the header's "Log In / Sign Up" becomes the player's name (links to the profile)
    html = html.replace('<a id="login-btn" class="btn btn-secondary" href="/login">Log In / Sign Up</a>', `<a id="login-btn" class="btn btn-secondary" href="/profile">${esc(vars.USER_NAME)}</a>`)
      .replace('<li class="nav-mobile"><a href="/login">Log In / Sign Up</a></li>', `<li class="nav-mobile"><a href="/profile">${esc(vars.USER_NAME)}</a></li>`);
  }
  return html;
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
                                            ${g.settings.isPrivate ? 'Private Games' : 'Public Games'}
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

module.exports = { render, esc, groupItem, setStatsProvider, loginCard, profileCard };
