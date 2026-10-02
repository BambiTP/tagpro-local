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
  return tpl(name).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
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

module.exports = { render, esc, groupItem, setStatsProvider };
