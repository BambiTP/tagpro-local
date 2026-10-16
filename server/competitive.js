// competitive.js - pages for the Competitive tab (tournaments.js holds the tournaments themselves):
// the list at /competitive, the organizer's create form, and the shell of a tournament's page
// (public/competitive.js draws it live).
const fs = require('fs');
const path = require('path');
const { esc } = require('./pages');

const MAPS = path.join(__dirname, '..', 'maps');
const FORMAT = { single: 'Single elimination', double: 'Double elimination', roundrobin: 'Round robin' };
const DRAFT = { snake: 'Snake draft', straight: 'Straight order draft', auction: 'Auction draft' };
const STATUS = { signup: 'Sign ups open', draft: 'Drafting', ready: 'Teams set', playing: 'In progress', done: 'Finished' };

const describe = (t) => `${FORMAT[t.format]}${t.format === 'roundrobin' && t.playoffTeams >= 2 ? ` + top ${t.playoffTeams} playoffs` : ''}, ${t.teamMode === 'draft' ? DRAFT[t.draftType] : 'premade teams'}, ${t.teamCount ? `${t.teamCount} teams` : 'as many teams as sign ups make'} of ${t.teamSize}, ${t.game.mode === 'eggball' ? 'eggball' : 'capture the flag'}`;

function listCard(list, organizer, error, form) {
  const rows = list.map((t) => `<tr><td><a href="/competitive/${esc(t.id)}"><b>${esc(t.name)}</b></a><div style="opacity:.7;font-size:12px">${esc(describe(t))}</div></td>
    <td>${STATUS[t.status]}</td><td class="text-right" style="opacity:.7">${new Date(t.created).toISOString().slice(0, 10)}</td></tr>`).join('');
  return `<h1>Competitive</h1>
    <p style="opacity:.7;margin-top:-6px">Tournaments, with teams made by a draft or entered by the organizer. Log in to sign up.</p>
    <table class="table table-condensed"><thead><tr><th>Tournament</th><th>Status</th><th class="text-right">Created</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" style="opacity:.7">No tournaments yet.</td></tr>'}</tbody></table>
    ${organizer ? createForm(error, form || {}) : ''}`;
}

// installed maps for the map choice (eggball plays on its own map)
function mapOptions(chosen) {
  const opts = [['random', 'Random (public rotation)']];
  for (const f of fs.readdirSync(MAPS)) {
    if (!f.endsWith('.json') || f === 'rotation.json' || f === 'manifest.json' || f.startsWith('upload-')) continue;
    const key = f.slice(0, -5);
    if (key === 'eggball' || !fs.existsSync(path.join(MAPS, key + '.png'))) continue;
    try { opts.push([key, JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8')).info.name || key]); } catch (e) { /* skip */ }
  }
  opts.sort((a, b) => (a[0] === 'random' ? -1 : b[0] === 'random' ? 1 : a[1].localeCompare(b[1])));
  return opts.map(([k, n]) => `<option value="${esc(k)}"${k === chosen ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

function createForm(error, f) {
  const v = (k, d) => esc(f[k] ?? d);
  const sel = (name, opts, d) => `<select class="form-control" name="${name}" id="c-${name}">${opts.map(([k, n]) => `<option value="${k}"${String(f[name] ?? d) === String(k) ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  const row = (label, input, id, help) => `<div class="form-group" ${id ? `id="${id}"` : ''}><label class="col-sm-4 control-label">${label}</label><div class="col-sm-8">${input}${help ? `<p class="help-block" style="font-size:12px">${help}</p>` : ''}</div></div>`;
  const num = (name, d, min, max) => `<input class="form-control" type="number" name="${name}" value="${v(name, d)}" min="${min}" max="${max}">`;
  return `<h3 id="create">Create a tournament</h3>
    ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
    <form class="form-horizontal" method="post" action="/competitive/create">
      ${row('Name', `<input class="form-control" name="name" maxlength="60" required value="${v('name', '')}">`)}
      ${row('Format', sel('format', [['single', FORMAT.single], ['double', FORMAT.double], ['roundrobin', FORMAT.roundrobin]], 'single'))}
      ${row('Playoff teams', num('playoffTeams', 4, 0, 16), 'c-playoffs', 'After the round robin, the top teams play a single elimination bracket. 0 = no playoffs (the table decides).')}
      ${row('Teams', sel('teamMode', [['draft', 'Draft from sign ups'], ['premade', 'Premade teams']], 'draft'))}
      ${row('Draft type', sel('draftType', [['snake', 'Snake (1-2-3-4, 4-3-2-1, ...)'], ['straight', 'Straight order (1-2-3-4 every round)'], ['auction', 'Auction (captains bid)']], 'snake'), 'c-draft', 'The organizer picks the captains (or uses the highest ratings). The lowest-rated captain picks first.')}
      ${row('Number of teams', sel('teamsFrom', [['signups', 'From sign ups (sign ups / players per team)'], ['fixed', 'Fixed number']], 'signups'), 'c-from', 'From sign ups: the team count is set when you start the draft; anyone left over after the last full team isn\'t drafted.')}
      ${row('Fixed number of teams', num('teamCount', 4, 2, 32), 'c-count')}
      ${row('Players per team', num('teamSize', 4, 1, 8))}
      ${row('Pick timer (seconds)', num('pickSeconds', 45, 10, 600), 'c-pick', 'When it runs out, the highest-rated player left is taken.')}
      ${row('Auction budget', num('budget', 100, 1, 10000), 'c-budget', 'Each captain\'s money. Every player costs at least 1.')}
      ${row('Bid timer (seconds)', num('bidSeconds', 12, 5, 120), 'c-bid', 'The top bid wins when it runs out.')}
      ${row('Premade teams', `<textarea class="form-control" name="premade" rows="5" placeholder="Team name: captain, player, player, player">${v('premade', '')}</textarea>`, 'c-premade', 'One team per line, players by username. The first player is the captain. Seeds follow the order of the lines.')}
      ${row('Game mode', sel('mode', [['classic', 'Capture the flag'], ['eggball', 'Eggball']], 'classic'))}
      ${row('Map', `<select class="form-control" name="map">${mapOptions(f.map || 'random')}</select>`, 'c-map')}
      ${row('Time limit (minutes)', num('time', 10, 1, 60))}
      ${row('Cap limit (0 = none)', num('caps', 0, 0, 50))}
      ${row('Mercy rule (lead, 0 = off)', num('mercyRule', 0, 0, 50))}
      ${row('Games per match', sel('bestOf', [[1, 'Best of 1'], [3, 'Best of 3'], [5, 'Best of 5'], [7, 'Best of 7']], 1), '', 'Ties are replayed in brackets; in a round robin a tie counts as a draw.')}
      ${row('Games in the final', sel('finalBestOf', [[1, 'Best of 1'], [3, 'Best of 3'], [5, 'Best of 5'], [7, 'Best of 7']], 1))}
      <div class="form-group"><div class="col-sm-offset-4 col-sm-8"><button class="btn btn-primary" type="submit">Create tournament</button></div></div>
    </form>
    <script>(function () {
      var f = document.querySelector('form[action="/competitive/create"]');
      function show(id, on) { var e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; }
      function update() {
        var draft = f.teamMode.value === 'draft', auction = draft && f.draftType.value === 'auction';
        show('c-playoffs', f.format.value === 'roundrobin'); show('c-draft', draft); show('c-from', draft); show('c-count', draft && f.teamsFrom.value === 'fixed'); show('c-pick', draft);
        show('c-budget', auction); show('c-bid', auction); show('c-premade', !draft); show('c-map', f.mode.value !== 'eggball');
      }
      f.addEventListener('change', update); update();
    })();</script>`;
}

function tournamentCard(t, ver) {
  return `<h1 id="t-name">${esc(t.name)}</h1>
    <p style="opacity:.7;margin-top:-6px">${esc(describe(t))}. <a href="/competitive">All tournaments</a></p>
    <div id="tournament"><p style="opacity:.7">Loading...</p></div>
    <script src="/socket.io/socket.io.min.js"></script>
    <script>window.TOURNAMENT_ID = ${JSON.stringify(t.id)};</script>
    <script src="/competitive.js?v=${ver}"></script>`;
}

module.exports = { listCard, tournamentCard };
