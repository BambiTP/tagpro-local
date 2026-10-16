// competitive.js - a tournament's page (Competitive tab): rules, sign ups, the draft, teams and the
// bracket, redrawn whenever the server sends a new state over socket.io (/competitive). The
// organizer also gets the controls: sign ups, captains, team changes, seeds, maps, results.
// Server side: server/tournaments.js.
(function () {
  var root = document.getElementById('tournament');
  var socket = io('/competitive', { transports: ['websocket', 'polling'] });
  var me = { id: null, organizer: false }, T = null, skew = 0, captainPicks = null, rulesOpen = null;

  var FORMAT = { single: 'Single elimination', double: 'Double elimination', roundrobin: 'Round robin' };
  var SECTION = { W: 'Bracket', L: 'Losers bracket', GF: 'Grand final', RR: 'Round robin', P: 'Playoffs' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function team(id) { for (var i = 0; i < T.teams.length; i++) if (T.teams[i].id === id) return T.teams[i]; return null; }
  function teamName(id) { if (id === 'BYE') return 'bye'; var t = team(id); return t ? t.name : 'TBD'; }
  function teamOfPlayer(id) { for (var i = 0; i < T.teams.length; i++) for (var j = 0; j < T.teams[i].players.length; j++) if (T.teams[i].players[j].id === id) return T.teams[i]; return null; }
  function myTeam() { return me.id ? teamOfPlayer(me.id) : null; }
  function signedUp() { return T.signups.some(function (p) { return p.id === me.id; }); }
  function btn(label, action, cls, extra) { return '<button type="button" class="btn btn-sm ' + (cls || 'btn-default') + '" data-act=\'' + esc(JSON.stringify(action)) + '\'' + (extra || '') + '>' + label + '</button> '; }
  function secs(deadline) { return Math.max(0, Math.ceil((deadline - (Date.now() + skew)) / 1000)); }
  function clock(deadline) { return '<span class="t-clock" data-deadline="' + deadline + '">' + secs(deadline) + '</span>s'; }
  function signupLink() { return location.origin + '/competitive/' + T.id + '/signup'; }
  // a player's name, with their verified TagPro account when they linked one
  function who(p) { return '<a href="/profile/' + esc(p.id) + '">' + esc(p.name) + '</a>' + (p.tagpro ? ' <a href="https://tagpro.koalabeast.com/profile/' + esc(p.tagpro.id) + '" target="_blank" rel="noopener" title="Verified TagPro account" style="opacity:.75;font-size:11px">(TagPro: ' + esc(p.tagpro.name || 'linked') + ')</a>' : ''); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function act(a) { socket.emit('act', a, function (err) { if (err) flash(err); }); }
  function flash(msg) {
    var e = document.getElementById('t-error');
    if (!e) return alert(msg);
    e.textContent = msg; e.style.display = '';
    clearTimeout(flash.t); flash.t = setTimeout(function () { e.style.display = 'none'; }, 6000);
  }

  // ---- rules: every setting and fixed rule, one short line each ----
  function rules() {
    var g = T.game, r = [];
    r.push(FORMAT[T.format] + (T.format === 'double' ? ' (grand final reset if the losers bracket team wins)' : '') + (T.format === 'roundrobin' ? (T.playoffTeams >= 2 ? ', top ' + T.playoffTeams + ' to playoffs' : ', no playoffs') : ''));
    if (T.format === 'roundrobin') r.push('Table: wins, then score difference');
    if (T.teamMode === 'draft') {
      r.push((T.teamCount ? plural(T.teamCount, 'team') : 'Teams from sign ups') + ' of ' + T.teamSize + '; sign up needs a linked TagPro account');
      r.push(({ snake: 'Snake draft', straight: 'Straight order draft', auction: 'Auction draft, ' + T.budget + ' each' })[T.draftType] + ', random captain order');
      r.push(T.draftType === 'auction' ? 'Nominate ' + T.pickSeconds + 's, bidding ' + T.bidSeconds + 's, each bid back to at least ' + T.bidResetSeconds + 's' : T.pickSeconds + 's per pick; time out = random pick');
    }
    r.push('Best of ' + g.bestOf + (g.finalBestOf !== g.bestOf ? ', final best of ' + g.finalBestOf : ''));
    r.push((g.mode === 'eggball' ? 'Eggball' : g.map === 'random' ? 'Random map' : g.mapName) + ', ' + plural(g.time, 'minute') + (g.caps ? ', ' + g.caps + ' caps' : '') + (g.mercyRule ? ', mercy ' + g.mercyRule : ''));
    r.push('No ties: overtime until someone scores');
    r.push('Colours swap every game');
    r.push('Both captains ready up to start');
    r.push('Empty game cancelled after ' + T.emptyGameMinutes + ' min');
    var open = rulesOpen === null ? false : rulesOpen;
    return '<details id="t-rules" style="margin-bottom:10px"' + (open ? ' open' : '') + '><summary style="cursor:pointer;font-weight:bold">Rules</summary><ul style="margin:6px 0 0;padding-left:20px">'
      + r.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>';
  }

  function banner() {
    var out = '';
    if (T.champion) out += '<div class="alert alert-success" style="font-size:18px"><b>' + esc(teamName(T.champion)) + '</b> won the tournament!</div>';
    var mine = myTeam();
    if (mine) T.matches.forEach(function (m) {
      if (m.live && (m.a === mine.id || m.b === mine.id)) out += '<div class="alert alert-info" style="font-size:16px">Your game against <b>' + esc(teamName(m.a === mine.id ? m.b : m.a)) + '</b> is running. <a class="btn btn-primary" href="/competitive/' + T.id + '/play">Join game</a></div>';
    });
    return out;
  }

  function signups() {
    var out = '<h3 id="signup">Sign ups (' + T.signups.length + (T.teamCount ? ' of ' + T.teamCount * T.teamSize + ' needed' : '') + ') '
      + (T.signupsOpen ? '<span class="label label-success">open</span>' : '<span class="label label-default">closed</span>') + '</h3>';
    if (!T.teamCount) {
      var left = T.signups.length - T.teamsWanted * T.teamSize;
      out += '<p>' + (T.teamsWanted >= 2 ? 'Enough for <b>' + T.teamsWanted + ' teams</b> of ' + T.teamSize + (left ? '; ' + (T.teamSize - left) + ' more for another team (' + left + ' left over now).' : '.') : 'Need ' + 2 * T.teamSize + ' sign ups for two teams of ' + T.teamSize + '.') + '</p>';
    }
    if (!me.id) out += '<p><a class="btn btn-success" href="/competitive/' + T.id + '/signup">Log in to sign up</a></p>';
    else if (signedUp()) out += '<p>You\'re signed up. ' + btn('Withdraw', { type: 'withdraw' }) + '</p>';
    else if (T.signupsOpen && !me.tagpro) out += '<p><a class="btn btn-success" href="/competitive/' + T.id + '/signup">Link TagPro account to sign up</a></p>';
    else if (T.signupsOpen) out += '<p>' + btn('Sign up', { type: 'signup' }, 'btn-success btn-lg') + '</p>';
    else out += '<p style="opacity:.7">Sign ups are closed.</p>';
    if (me.organizer) {
      out += '<p>' + (T.signupsOpen ? btn('Close sign ups', { type: 'closeSignups' }) : btn('Open sign ups', { type: 'openSignups' }, 'btn-success'))
        + ' Sign up link: <input id="t-link" readonly class="form-control input-sm" style="display:inline-block;width:auto;min-width:260px" value="' + esc(signupLink()) + '"> ' + btn('Copy', { type: 'copyLink' }) + '</p>';
    }
    if (!T.signups.length) return out + '<p style="opacity:.7">Nobody yet.</p>';
    var org = me.organizer;
    if (org && !captainPicks) captainPicks = T.captains.slice();
    out += '<table class="table table-condensed"><thead><tr><th>Player</th><th>' + (org ? 'Captain' : '') + '</th><th></th></tr></thead><tbody>';
    T.signups.forEach(function (p) {
      var cap = T.captains.indexOf(p.id) >= 0;
      out += '<tr><td>' + who(p) + (cap && !org ? ' <span class="label label-primary">captain</span>' : '') + '</td><td>'
        + (org ? '<input type="checkbox" class="t-cap" value="' + esc(p.id) + '"' + (captainPicks.indexOf(p.id) >= 0 ? ' checked' : '') + '>' : '') + '</td><td class="text-right">'
        + (org ? btn('Remove', { type: 'remove', player: p.id }, 'btn-xs btn-link', ' data-confirm="1"') : '') + '</td></tr>';
    });
    out += '</tbody></table>';
    if (org) out += '<p>' + btn('Save captains', { type: 'captainsFromBoxes' }) + btn('Start draft', { type: 'startDraft' }, 'btn-primary', ' data-confirm="1"')
      + ' <span style="opacity:.7">' + T.captains.length + ' of ' + T.teamsWanted + ' captains saved</span></p>';
    return out;
  }

  function draft() {
    var d = T.draft;
    if (!d || d.done) return '';
    var out = '<h3>Draft <small>' + ({ snake: 'snake', straight: 'straight order', auction: 'auction' })[d.type] + '</small></h3>';
    out += '<p style="opacity:.7;margin-top:-6px">Order: ' + T.teams.map(function (t, i) { return (i + 1) + '. ' + esc(t.name); }).join(', ') + '</p>';
    var clockTeam = d.onClock && team(d.onClock);
    var mineOnClock = clockTeam && (clockTeam.captain === me.id || me.organizer);
    var mine = T.teams.filter(function (t) { return t.captain === me.id; })[0];
    if (d.type !== 'auction') {
      out += '<p style="font-size:16px">Pick ' + (d.pick + 1) + ' of ' + d.total + ': <b>' + esc(clockTeam.name) + '</b> is picking (' + clock(d.deadline) + ').'
        + (d.order[d.pick + 1] ? ' Next: ' + esc(teamName(d.order[d.pick + 1])) + '.' : '') + '</p>';
    } else if (d.lot) {
      var p = T.signups.filter(function (x) { return x.id === d.lot.player; })[0];
      out += '<div class="well"><p style="font-size:16px">Up for auction: <b>' + esc(p && p.name) + '</b>. Top bid <b>' + d.lot.bid + '</b> by ' + esc(teamName(d.lot.bidder)) + '. Sold in ' + clock(d.lot.deadline) + '.</p>'
        + '<p style="opacity:.7;margin-top:-6px">Each bid puts the clock back up to at least ' + T.bidResetSeconds + 's.</p>';
      if (mine && mine.id !== d.lot.bidder && d.maxBids[mine.id] > d.lot.bid) {
        out += '<p><input id="t-bid" type="number" class="form-control" style="display:inline-block;width:110px" min="' + (d.lot.bid + 1) + '" max="' + d.maxBids[mine.id] + '" value="' + (d.lot.bid + 1) + '"> '
          + btn('Bid', { type: 'bidFromBox' }, 'btn-primary') + btn('+1', { type: 'bid', amount: d.lot.bid + 1 }) + btn('+5', { type: 'bid', amount: Math.min(d.maxBids[mine.id], d.lot.bid + 5) })
          + ' <span style="opacity:.7">you can bid up to ' + d.maxBids[mine.id] + '</span></p>';
      }
      out += '</div>';
    } else {
      out += '<p style="font-size:16px"><b>' + esc(clockTeam.name) + '</b> nominates a player (' + clock(d.deadline) + ').</p>';
      if (mineOnClock) out += '<p>Opening bid: <input id="t-open" type="number" class="form-control" style="display:inline-block;width:110px" min="1" max="' + d.maxBids[clockTeam.id] + '" value="1"> then press Nominate next to a player.</p>';
    }
    if (d.type === 'auction') out += '<p>' + T.teams.map(function (t) { return esc(t.name) + ': <b>' + d.budgets[t.id] + '</b> left'; }).join(' &middot; ') + '</p>';
    var avail = T.signups.filter(function (p) { return !teamOfPlayer(p.id); });
    var canAct = d.type === 'auction' ? (mineOnClock && !d.lot) : mineOnClock;
    out += '<h4>Available (' + avail.length + ')</h4><table class="table table-condensed"><tbody>' + avail.map(function (p) {
      return '<tr><td>' + who(p) + '</td><td class="text-right">'
        + (canAct ? (d.type === 'auction' ? btn('Nominate', { type: 'nominateFromBox', player: p.id }, 'btn-xs btn-primary') : btn('Pick', { type: 'pick', player: p.id }, 'btn-xs btn-primary')) : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
    return out;
  }

  function teams() {
    if (!T.teams.length) return '';
    var d = T.draft, editing = me.organizer && (T.status === 'ready' || T.status === 'playing'), seeding = me.organizer && T.status === 'ready';
    var out = '<h3>Teams</h3>';
    out += '<div style="display:flex;flex-wrap:wrap;gap:10px">' + T.teams.map(function (t, i) {
      var onClock = d && !d.done && d.onClock === t.id;
      var head = editing
        ? '<input class="form-control input-sm t-rename" data-team="' + esc(t.id) + '" value="' + esc(t.name) + '" maxlength="30" style="display:inline-block;width:150px"> ' + btn('Rename', { type: 'renameFromBox', team: t.id }, 'btn-xs')
        : '<b>' + esc(t.name) + '</b>';
      var seed = T.status !== 'signup' && T.status !== 'draft' ? ' <span style="opacity:.6">seed ' + (i + 1) + '</span>' : '';
      if (seeding) seed += ' ' + btn('&uarr;', { type: 'seed', team: t.id, dir: -1 }, 'btn-xs') + btn('&darr;', { type: 'seed', team: t.id, dir: 1 }, 'btn-xs') + (t.players.length ? '' : btn('Delete team', { type: 'removeTeam', team: t.id }, 'btn-xs btn-link'));
      var body = t.players.map(function (p) {
        var row = '<div>' + who(p) + (p.id === t.captain ? ' <span class="label label-primary">C</span>' : '');
        if (editing) {
          row += ' <select class="input-sm t-move" data-player="' + esc(p.id) + '" style="height:22px;padding:0 2px;font-size:11px"><option value="">move to...</option>'
            + T.teams.filter(function (x) { return x.id !== t.id; }).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('')
            + '<option value="__out">(remove from team)</option></select>';
          if (p.id !== t.captain) row += ' ' + btn('make captain', { type: 'setCaptain', team: t.id, player: p.id }, 'btn-xs btn-link');
        }
        return row + '</div>';
      }).join('') + Array(Math.max(0, T.teamSize - t.players.length) + 1).join('<div style="opacity:.4">open</div>');
      if (editing) body += '<div style="margin-top:4px"><input class="form-control input-sm t-add" data-team="' + esc(t.id) + '" placeholder="username" style="display:inline-block;width:120px"> ' + btn('Add player', { type: 'addFromBox', team: t.id }, 'btn-xs') + '</div>';
      return '<div class="panel panel-default" style="min-width:200px;flex:1 1 200px;margin:0' + (onClock ? ';border-color:#8BC34A' : '') + '"><div class="panel-heading">' + head + seed
        + (d && d.type === 'auction' && !d.done ? ' <span style="opacity:.7">(' + d.budgets[t.id] + ')</span>' : '') + '</div><div class="panel-body" style="padding:6px 10px">' + body + '</div></div>';
    }).join('') + '</div>';
    if (seeding) out += '<p style="margin-top:8px"><input id="t-newteam" class="form-control input-sm" placeholder="new team name" style="display:inline-block;width:160px"> ' + btn('Add team', { type: 'addTeamFromBox' }, 'btn-xs') + '</p>';
    return out;
  }

  function mapSelect(m) {
    if (!me.organizer || !T.maps.length || m.done) return '';
    return '<div style="margin-top:3px;font-size:11px"><select class="t-map" data-match="' + esc(m.id) + '" style="max-width:150px;font-size:11px"><option value="">default (' + esc(T.game.mapName) + ')</option>'
      + T.maps.map(function (x) { return '<option value="' + esc(x.key) + '"' + (m.map === x.key ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('')
      + '</select> <label style="font-weight:normal"><input type="checkbox" class="t-maproundbox" data-match="' + esc(m.id) + '"> whole round</label></div>';
  }

  function matchBox(m) {
    var side = function (s) {
      var id = m[s], won = m.done && m.winner === id && !m.bye;
      return '<div style="display:flex;justify-content:space-between;' + (won ? 'font-weight:bold;' : '') + (m.done && !won ? 'opacity:.6' : '') + '"><span>' + esc(teamName(id)) + '</span><span>' + (m.bye || id === null ? '' : m.wins[s]) + '</span></div>';
    };
    var out = '<div class="t-match" style="border:1px solid rgba(128,128,128,.4);border-radius:4px;padding:5px 8px;margin:6px 0;min-width:190px' + (m.live ? ';border-color:#03A9F4' : '') + '">'
      + '<div style="font-size:11px;opacity:.6">' + esc(m.label) + (m.bestOf > 1 ? ' &middot; best of ' + m.bestOf : '') + (!m.done && !m.bye ? ' &middot; ' + esc(m.mapName) : '') + '</div>' + side('a') + side('b');
    if (m.bye) out += '<div style="font-size:11px;opacity:.6">bye</div>';
    if (m.forfeit) out += '<div style="font-size:11px;opacity:.6">decided by the organizer</div>';
    m.games.forEach(function (g, i) {
      out += '<div style="font-size:11px;opacity:.7">Game ' + (i + 1) + ': ' + g.score.a + '-' + g.score.b + (g.map ? ' on ' + esc(g.map) : '') + (g.counted ? '' : ' (didn\'t count)') + (g.replay ? ' <a href="/game?replay=' + encodeURIComponent(g.replay) + '">replay</a>' : '') + '</div>';
    });
    if (m.note) out += '<div style="font-size:11px;color:#f0ad4e">' + esc(m.note) + '</div>';
    if (m.live) {
      var mine = myTeam(), playing = mine && (mine.id === m.a || mine.id === m.b);
      out += '<div style="margin-top:4px">' + (playing ? '<a class="btn btn-xs btn-primary" href="/competitive/' + T.id + '/play">Join game</a> ' : '<a class="btn btn-xs btn-default" href="/competitive/' + T.id + '/play?match=' + esc(m.id) + '">Watch</a> ')
        + (me.organizer ? btn('Cancel game', { type: 'cancelGame', match: m.id }, 'btn-xs btn-link', ' data-confirm="1"') : '') + '</div>';
    } else if (m.playable && T.status === 'playing') {
      var caps = [team(m.a), team(m.b)];
      var myCap = caps.filter(function (t) { return t && t.captain === me.id; })[0];
      out += '<div style="font-size:11px;margin-top:4px">' + caps.map(function (t) { return esc(t.name) + (m.ready.indexOf(t.id) >= 0 ? ' ready' : ' not ready'); }).join(', ') + '</div><div>';
      if (myCap) out += m.ready.indexOf(myCap.id) >= 0 ? btn('Not ready', { type: 'ready', match: m.id, on: false }, 'btn-xs btn-default') : btn('Ready', { type: 'ready', match: m.id, on: true }, 'btn-xs btn-success');
      if (me.organizer) out += btn('Start now', { type: 'forceStart', match: m.id }, 'btn-xs btn-primary') + btn(esc(teamName(m.a)) + ' wins', { type: 'award', match: m.id, side: 'a' }, 'btn-xs btn-link', ' data-confirm="1"') + btn(esc(teamName(m.b)) + ' wins', { type: 'award', match: m.id, side: 'b' }, 'btn-xs btn-link', ' data-confirm="1"');
      out += '</div>';
    }
    if (!m.bye && !m.live && T.status !== 'done') out += mapSelect(m);
    return out + '</div>';
  }

  function bracket() {
    if (!T.matches.length) return '';
    var out = '';
    if (T.standings) {
      out += '<h3>Table</h3><table class="table table-condensed"><thead><tr><th>#</th><th>Team</th><th class="text-right">Played</th><th class="text-right">Won</th><th class="text-right">Lost</th><th class="text-right">Score</th></tr></thead><tbody>'
        + T.standings.map(function (r, i) {
          var cut = T.playoffTeams >= 2 && i === T.playoffTeams - 1 ? ' style="border-bottom:2px solid #8BC34A"' : '';
          return '<tr' + cut + '><td>' + (i + 1) + '</td><td>' + esc(teamName(r.team)) + '</td><td class="text-right">' + r.played + '</td><td class="text-right"><b>' + r.wins + '</b></td><td class="text-right">' + r.losses + '</td><td class="text-right">' + r.for + '-' + r.against + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    ['W', 'L', 'GF', 'RR', 'P'].forEach(function (b) {
      var ms = T.matches.filter(function (m) { return m.bracket === b; });
      if (!ms.length) return;
      var rounds = [];
      ms.forEach(function (m) { (rounds[m.round] = rounds[m.round] || []).push(m); });
      out += '<h3>' + SECTION[b] + '</h3><div style="display:flex;gap:14px;overflow-x:auto;padding-bottom:6px">';
      rounds.forEach(function (list) {
        if (!list) return;
        out += '<div style="display:flex;flex-direction:column;justify-content:space-around;flex:0 0 auto">' + list.map(matchBox).join('') + '</div>';
      });
      out += '</div>';
    });
    return out;
  }

  function organizer() {
    if (!me.organizer) return '';
    var out = '<hr><h4>Organizer</h4><p>';
    if (T.status === 'ready') out += btn('Start tournament', { type: 'start' }, 'btn-primary', ' data-confirm="1"');
    out += '<a class="btn btn-sm btn-default" href="/competitive/' + T.id + '/edit">Edit settings</a> ';
    out += btn('Delete tournament', { type: 'delete' }, 'btn-danger', ' data-confirm="1"') + '</p>';
    return out;
  }

  var STATUS = { signup: 'sign ups', draft: 'drafting', ready: 'teams set, waiting for the organizer to start', playing: 'in progress', done: 'finished' };
  function render() {
    // keep typed text, the open/closed rules box and focus across redraws
    var keep = {}, focus = document.activeElement && document.activeElement.id;
    root.querySelectorAll('input[id]').forEach(function (e) { keep[e.id] = e.value; });
    var typing = {};
    root.querySelectorAll('.t-rename, .t-add').forEach(function (e) { if (e.value && (e.classList.contains('t-add') || e === document.activeElement)) typing[(e.classList.contains('t-add') ? 'add:' : 'rename:') + e.getAttribute('data-team')] = { value: e.value, focus: e === document.activeElement }; });
    root.innerHTML = '<div id="t-error" class="alert alert-danger" style="display:none"></div>' + banner()
      + '<p><b>Status:</b> ' + STATUS[T.status] + '</p>' + rules()
      + (T.teamMode === 'draft' && T.status === 'signup' ? signups() : '') + draft() + teams() + bracket() + organizer();
    Object.keys(keep).forEach(function (id) { var e = document.getElementById(id); if (e && id !== 't-bid' && id !== 't-link') e.value = keep[id]; });
    Object.keys(typing).forEach(function (k) {
      var parts = k.split(':'), e = root.querySelector((parts[0] === 'add' ? '.t-add' : '.t-rename') + '[data-team="' + parts[1] + '"]');
      if (e) { e.value = typing[k].value; if (typing[k].focus) e.focus(); }
    });
    if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
    if (location.hash === '#signup' && !render.scrolled && document.getElementById('signup')) { render.scrolled = true; document.getElementById('signup').scrollIntoView(); }
  }

  root.addEventListener('toggle', function (e) { if (e.target.id === 't-rules') rulesOpen = e.target.open; }, true);
  root.addEventListener('change', function (e) {
    var el = e.target;
    if (el.classList.contains('t-cap')) captainPicks = [].map.call(root.querySelectorAll('.t-cap:checked'), function (x) { return x.value; });
    if (el.classList.contains('t-move') && el.value) act({ type: 'movePlayer', player: el.getAttribute('data-player'), team: el.value === '__out' ? null : el.value });
    if (el.classList.contains('t-map')) {
      var whole = root.querySelector('.t-maproundbox[data-match="' + el.getAttribute('data-match') + '"]');
      act({ type: 'setMap', match: el.getAttribute('data-match'), map: el.value, round: !!(whole && whole.checked) });
    }
  });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var a = JSON.parse(b.getAttribute('data-act'));
    if (b.getAttribute('data-confirm') && !confirm(b.textContent.trim() + '?')) return;
    var box = function (sel) { var x = root.querySelector(sel); return x ? x.value : ''; };
    if (a.type === 'copyLink') {
      var l = document.getElementById('t-link'); l.select();
      if (navigator.clipboard) navigator.clipboard.writeText(l.value).catch(function () { document.execCommand('copy'); }); else document.execCommand('copy');
      b.textContent = 'Copied'; return;
    }
    if (a.type === 'captainsFromBoxes') a = { type: 'captains', ids: captainPicks || [] };
    if (a.type === 'bidFromBox') a = { type: 'bid', amount: Number(box('#t-bid')) };
    if (a.type === 'nominateFromBox') a = { type: 'nominate', player: a.player, bid: Number(box('#t-open') || 1) };
    if (a.type === 'renameFromBox') a = { type: 'renameTeam', team: a.team, name: box('.t-rename[data-team="' + a.team + '"]') };
    if (a.type === 'addFromBox') { a = { type: 'addPlayer', team: a.team, username: box('.t-add[data-team="' + a.team + '"]') }; var input = root.querySelector('.t-add[data-team="' + a.team + '"]'); if (input) input.value = ''; }
    if (a.type === 'addTeamFromBox') { a = { type: 'addTeam', name: box('#t-newteam') }; document.getElementById('t-newteam').value = ''; }
    if (a.type === 'captains') captainPicks = null;
    act(a);
  });

  setInterval(function () { root.querySelectorAll('.t-clock').forEach(function (e) { e.textContent = secs(Number(e.getAttribute('data-deadline'))); }); }, 250);

  socket.on('connect', function () { socket.emit('watch', window.TOURNAMENT_ID); });
  socket.on('me', function (m) { me = m; });
  socket.on('state', function (s) {
    skew = s.now - Date.now();
    T = s;
    if (T.status !== 'signup') captainPicks = null;
    else if (captainPicks) captainPicks = captainPicks.filter(function (id) { return T.signups.some(function (p) { return p.id === id; }); });
    var name = document.getElementById('t-name');
    if (name) name.textContent = T.name;
    render();
  });
  socket.on('gone', function () { root.innerHTML = '<p>This tournament was deleted. <a href="/competitive">All tournaments</a></p>'; });
})();
