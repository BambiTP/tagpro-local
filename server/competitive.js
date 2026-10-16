// competitive.js - pages for the Competitive tab (tournaments.js holds the tournaments themselves):
// the list at /competitive, the organizer's create / edit form, and the shell of a tournament's
// page (public/competitive.js draws it live).
const fs = require('fs');
const path = require('path');
const { esc } = require('./pages');

const MAPS = path.join(__dirname, '..', 'maps');
const FORMAT = { single: 'Single elimination', double: 'Double elimination', roundrobin: 'Round robin' };
const DRAFT = { snake: 'Snake draft', straight: 'Straight order draft', auction: 'Auction draft' };
const STATUS = { signup: 'Sign ups', draft: 'Drafting', ready: 'Teams set', playing: 'In progress', done: 'Finished' };

const describe = (t) => `${FORMAT[t.format]}${t.format === 'roundrobin' && t.playoffTeams >= 2 ? ` + top ${t.playoffTeams} playoffs` : ''}, ${t.teamMode === 'draft' ? DRAFT[t.draftType] : 'premade teams'}, ${t.teamCount ? `${t.teamCount} teams` : 'as many teams as sign ups make'} of ${t.teamSize}, ${t.game.mode === 'eggball' ? 'eggball' : 'capture the flag'}`;

// installed maps a tournament can use (eggball plays on its own map): [{ key, name }] by name
let mapCache = null;
function mapList() {
  const mtime = fs.statSync(MAPS).mtimeMs;
  if (mapCache && mapCache.mtime === mtime) return mapCache.list;
  const list = [];
  for (const f of fs.readdirSync(MAPS)) {
    if (!f.endsWith('.json') || f === 'rotation.json' || f === 'manifest.json' || f.startsWith('upload-')) continue;
    const key = f.slice(0, -5);
    if (key === 'eggball' || !fs.existsSync(path.join(MAPS, key + '.png'))) continue;
    try { list.push({ key, name: JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8')).info.name || key }); } catch (e) { /* skip */ }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  mapCache = { mtime, list };
  return list;
}

function listCard(list, organizer, signupsOpen, error, form) {
  const rows = list.map((t) => `<tr><td><a href="/competitive/${esc(t.id)}"><b>${esc(t.name)}</b></a><div style="opacity:.7;font-size:12px">${esc(describe(t))}</div></td>
    <td>${t.status === 'signup' ? (signupsOpen(t) ? 'Sign ups open' : 'Sign ups closed') : STATUS[t.status]}</td><td class="text-right" style="opacity:.7">${new Date(t.created).toISOString().slice(0, 10)}</td></tr>`).join('');
  return `<h1>Competitive</h1>
    <p style="opacity:.7;margin-top:-6px">Tournaments, with teams made by a draft or entered by the organizer. Log in to sign up.</p>
    <table class="table table-condensed"><thead><tr><th>Tournament</th><th>Status</th><th class="text-right">Created</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" style="opacity:.7">No tournaments yet.</td></tr>'}</tbody></table>
    ${organizer ? settingsForm({ error, form: form || {} }) : ''}`;
}

// the tournament's current settings as form values (for the edit page)
function formValues(t) {
  return Object.assign({
    name: t.name, format: t.format, playoffTeams: t.playoffTeams, teamMode: t.teamMode, draftType: t.draftType,
    teamsFrom: t.teamCount ? 'fixed' : 'signups', teamCount: t.teamCount || 4, teamSize: t.teamSize,
    budget: t.budget, pickSeconds: t.pickSeconds, bidSeconds: t.bidSeconds, bidResetSeconds: t.bidResetSeconds || 8,
  }, t.game);
}

// create (no tournament) or edit (t; can = which groups of settings can still change)
function settingsForm({ error, form, t, can }) {
  const f = form, editing = !!t;
  const v = (k, d) => esc(f[k] ?? d);
  const off = (group) => (editing && group && !can[group] ? ' disabled' : '');
  const sel = (name, opts, d, group) => `<select class="form-control" name="${name}"${off(group)}>${opts.map(([k, n]) => `<option value="${k}"${String(f[name] ?? d) === String(k) ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  const row = (label, input, id, help) => `<div class="form-group" ${id ? `id="${id}"` : ''}><label class="col-sm-4 control-label">${label}</label><div class="col-sm-8">${input}${help ? `<p class="help-block" style="font-size:12px">${help}</p>` : ''}</div></div>`;
  const num = (name, d, min, max, group) => `<input class="form-control" type="number" name="${name}" value="${v(name, d)}" min="${min}" max="${max}"${off(group)}>`;
  const lockNote = (group, when) => (editing && !can[group] ? ` <span style="opacity:.6;font-weight:normal">(locked: ${when})</span>` : '');
  const maps = [['random', 'Random (public rotation)'], ...mapList().map((m) => [esc(m.key), esc(m.name)])];
  const draftMode = editing ? t.teamMode === 'draft' : true;
  return `<h3 id="create">${editing ? 'Tournament settings' : 'Create a tournament'}</h3>
    ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
    ${editing ? '<p style="opacity:.7">Game settings apply to games that start after you save. A match that has already played a game keeps its best-of.</p>' : ''}
    <form class="form-horizontal" method="post" action="${editing ? `/competitive/${esc(t.id)}/edit` : '/competitive/create'}" id="t-settings">
      ${row('Name', `<input class="form-control" name="name" maxlength="60" required value="${v('name', '')}">`)}
      ${row('Format' + lockNote('format', 'the bracket has started'), sel('format', [['single', FORMAT.single], ['double', FORMAT.double], ['roundrobin', FORMAT.roundrobin]], 'single', 'format'))}
      ${row('Playoff teams', num('playoffTeams', 4, 0, 16, 'format'), 'c-playoffs', 'After the round robin, the top teams play a single elimination bracket. 0 = no playoffs (the table decides).')}
      ${editing ? '' : row('Teams', sel('teamMode', [['draft', 'Draft from sign ups'], ['premade', 'Premade teams']], 'draft'))}
      ${draftMode ? `
      ${row('Draft type' + lockNote('teams', 'the draft has started'), sel('draftType', [['snake', 'Snake (1-2-3-4, 4-3-2-1, ...)'], ['straight', 'Straight order (1-2-3-4 every round)'], ['auction', 'Auction (captains bid)']], 'snake', 'teams'), 'c-draft', 'You pick the captains. They pick in a random order, shown when the draft starts.')}
      ${row('Number of teams', sel('teamsFrom', [['signups', 'From sign ups (sign ups / players per team)'], ['fixed', 'Fixed number']], 'signups', 'teams'), 'c-from', 'From sign ups: the team count is set when you start the draft; anyone left over after the last full team isn\'t drafted.')}
      ${row('Fixed number of teams', num('teamCount', 4, 2, 32, 'teams'), 'c-count')}` : ''}
      ${row('Players per team' + lockNote('teams', 'the draft has started'), num('teamSize', 4, 1, 8, 'teams'))}
      ${draftMode ? `
      ${row('Pick timer (seconds)' + lockNote('timers', 'the draft is over'), num('pickSeconds', 45, 10, 600, 'timers'), 'c-pick', 'Time for each pick (or auction nomination). When it runs out, a random player left is picked (or nominated for 1).')}
      ${row('Auction budget', num('budget', 100, 1, 10000, 'teams'), 'c-budget', 'Each captain\'s money. Every player costs at least 1.')}
      ${row('Bid timer (seconds)', num('bidSeconds', 12, 5, 120, 'timers'), 'c-bid', 'How long bidding runs after a player is nominated. The top bid wins when it runs out.')}
      ${row('Clock after a bid (seconds)', num('bidResetSeconds', 8, 1, 120, 'timers'), 'c-bidreset', 'Each bid puts the clock back up to at least this. Set it the same as the bid timer to restart the full timer on every bid.')}` : ''}
      ${editing ? '' : row('Premade teams', `<textarea class="form-control" name="premade" rows="5" placeholder="Team name: captain, player, player, player">${v('premade', '')}</textarea>`, 'c-premade', 'One team per line, players by username. The first player is the captain. Seeds follow the order of the lines; you can change teams and seeds afterwards.')}
      ${row('Game mode', sel('mode', [['classic', 'Capture the flag'], ['eggball', 'Eggball']], 'classic'))}
      ${row('Default map', `<select class="form-control" name="map">${maps.map(([k, n]) => `<option value="${k}"${k === esc(f.map || 'random') ? ' selected' : ''}>${n}</option>`).join('')}</select>`, 'c-map', 'Used unless you pick a map for a match (or a whole round) on the bracket.')}
      ${row('Time limit (minutes)', num('time', 10, 1, 60), '', 'If the score is level at the end, overtime is played until someone scores. There are no ties.')}
      ${row('Cap limit (0 = none)', num('caps', 0, 0, 50))}
      ${row('Mercy rule (lead, 0 = off)', num('mercyRule', 0, 0, 50))}
      ${row('Games per match', sel('bestOf', [[1, 'Best of 1'], [3, 'Best of 3'], [5, 'Best of 5'], [7, 'Best of 7']], 1))}
      ${row('Games in the final', sel('finalBestOf', [[1, 'Best of 1'], [3, 'Best of 3'], [5, 'Best of 5'], [7, 'Best of 7']], 1))}
      <div class="form-group"><div class="col-sm-offset-4 col-sm-8"><button class="btn btn-primary" type="submit">${editing ? 'Save settings' : 'Create tournament'}</button>${editing ? ` <a class="btn btn-default" href="/competitive/${esc(t.id)}">Back</a>` : ''}</div></div>
    </form>
    <script>(function () {
      var f = document.getElementById('t-settings');
      function val(n) { return f[n] ? f[n].value : ''; }
      function show(id, on) { var e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; }
      function update() {
        var draft = f.teamMode ? val('teamMode') === 'draft' : ${draftMode ? 'true' : 'false'}, auction = draft && val('draftType') === 'auction';
        show('c-playoffs', val('format') === 'roundrobin'); show('c-draft', draft); show('c-from', draft); show('c-count', draft && val('teamsFrom') === 'fixed'); show('c-pick', draft);
        show('c-budget', auction); show('c-bid', auction); show('c-bidreset', auction); show('c-premade', !draft); show('c-map', val('mode') !== 'eggball');
      }
      f.addEventListener('change', update); update();
    })();</script>`;
}

function editCard(t, can, error, form) {
  return `<h1>${esc(t.name)}</h1>${settingsForm({ error, form: form || formValues(t), t, can })}`;
}

function tournamentCard(t, ver) {
  return `<h1 id="t-name">${esc(t.name)}</h1>
    <p style="opacity:.7;margin-top:-6px">${esc(describe(t))}. <a href="/competitive">All tournaments</a></p>
    <div id="tournament"><p style="opacity:.7">Loading...</p></div>
    <script src="/socket.io/socket.io.min.js"></script>
    <script>window.TOURNAMENT_ID = ${JSON.stringify(t.id)};</script>
    <script src="/competitive.js?v=${ver}"></script>`;
}

module.exports = { listCard, editCard, tournamentCard, mapList };
