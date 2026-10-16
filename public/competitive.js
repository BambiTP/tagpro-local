// competitive.js - a tournament's page (Competitive tab): sign ups, the draft, teams and the
// bracket, redrawn whenever the server sends a new state over socket.io (/competitive).
// Server side: server/tournaments.js.
(function () {
  var root = document.getElementById('tournament');
  var socket = io('/competitive', { transports: ['websocket', 'polling'] });
  var me = { id: null, organizer: false }, T = null, skew = 0, captainPicks = null;

  var FORMAT = { single: 'Single elimination', double: 'Double elimination', roundrobin: 'Round robin' };
  var SECTION = { W: 'Bracket', L: 'Losers bracket', GF: 'Grand final', RR: 'Round robin', P: 'Playoffs' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function team(id) { for (var i = 0; i < T.teams.length; i++) if (T.teams[i].id === id) return T.teams[i]; return null; }
  function teamName(id) { if (id === 'BYE') return 'bye'; var t = team(id); return t ? t.name : 'TBD'; }
  function myTeam() { for (var i = 0; i < T.teams.length; i++) for (var j = 0; j < T.teams[i].players.length; j++) if (T.teams[i].players[j].id === me.id) return T.teams[i]; return null; }
  function signedUp() { return T.signups.some(function (p) { return p.id === me.id; }); }
  function taken(id) { return T.teams.some(function (t) { return t.players.some(function (p) { return p.id === id; }); }); }
  function btn(label, action, cls, extra) { return '<button class="btn btn-sm ' + (cls || 'btn-default') + '" data-act=\'' + esc(JSON.stringify(action)) + '\'' + (extra || '') + '>' + label + '</button> '; }
  function secs(deadline) { return Math.max(0, Math.ceil((deadline - (Date.now() + skew)) / 1000)); }
  function clock(deadline) { return '<span class="t-clock" data-deadline="' + deadline + '">' + secs(deadline) + '</span>s'; }

  function act(a) {
    socket.emit('act', a, function (err) { if (err) flash(err); });
  }
  function flash(msg) {
    var e = document.getElementById('t-error');
    if (!e) return alert(msg);
    e.textContent = msg; e.style.display = '';
    clearTimeout(flash.t); flash.t = setTimeout(function () { e.style.display = 'none'; }, 6000);
  }

  // ---- sections ----
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
    var draft = T.teamMode === 'draft';
    var out = '<h3>Sign ups (' + T.signups.length + (draft ? ' of ' + T.teamCount * T.teamSize + ' needed' : '') + ')</h3>';
    if (T.status === 'signup') {
      if (!me.id) out += '<p><a href="/login">Log in</a> to sign up.</p>';
      else out += signedUp() ? btn('Withdraw', { type: 'withdraw' }) : btn('Sign up', { type: 'signup' }, 'btn-success');
    }
    if (!T.signups.length) return out + '<p style="opacity:.7">Nobody yet.</p>';
    var org = me.organizer && T.status === 'signup';
    if (org && !captainPicks) captainPicks = T.captains.slice();
    out += '<table class="table table-condensed"><thead><tr><th>Player</th><th class="text-right">Rating</th><th>' + (org ? 'Captain' : '') + '</th><th></th></tr></thead><tbody>';
    T.signups.slice().sort(function (a, b) { return b.rating - a.rating; }).forEach(function (p) {
      var cap = T.captains.indexOf(p.id) >= 0;
      out += '<tr><td><a href="/profile/' + esc(p.id) + '">' + esc(p.name) + '</a>' + (cap && !org ? ' <span class="label label-primary">captain</span>' : '') + (taken(p.id) ? ' <span style="opacity:.6">(' + esc(myTeamOf(p.id)) + ')</span>' : '') + '</td><td class="text-right">' + p.rating + '</td><td>'
        + (org ? '<input type="checkbox" class="t-cap" value="' + esc(p.id) + '"' + (captainPicks.indexOf(p.id) >= 0 ? ' checked' : '') + '>' : '') + '</td><td class="text-right">'
        + (org ? btn('Remove', { type: 'remove', player: p.id }, 'btn-xs btn-link') : '') + '</td></tr>';
    });
    out += '</tbody></table>';
    if (org) {
      out += '<p>' + btn('Save captains', { type: 'captainsFromBoxes' }) + btn('Highest ratings captain', { type: 'autoCaptains' })
        + btn('Start draft', { type: 'startDraft' }, 'btn-primary') + ' <span style="opacity:.7">' + T.captains.length + ' of ' + T.teamCount + ' captains chosen</span></p>';
    }
    return out;
  }
  function myTeamOf(id) { for (var i = 0; i < T.teams.length; i++) if (T.teams[i].players.some(function (p) { return p.id === id; })) return T.teams[i].name; return ''; }

  function draft() {
    var d = T.draft;
    if (!d || d.done) return '';
    var out = '<h3>Draft <small>' + ({ snake: 'snake', straight: 'straight order', auction: 'auction' })[d.type] + '</small></h3>';
    var clockTeam = d.onClock && team(d.onClock);
    var mineOnClock = clockTeam && (clockTeam.captain === me.id || me.organizer);
    var mine = T.teams.filter(function (t) { return t.captain === me.id; })[0];
    if (d.type !== 'auction') {
      out += '<p style="font-size:16px">Pick ' + (d.pick + 1) + ' of ' + d.total + ': <b>' + esc(clockTeam.name) + '</b> is picking (' + clock(d.deadline) + ').'
        + (d.order[d.pick + 1] ? ' Next: ' + esc(teamName(d.order[d.pick + 1])) + '.' : '') + '</p>';
    } else if (d.lot) {
      var p = T.signups.filter(function (x) { return x.id === d.lot.player; })[0];
      out += '<div class="well"><p style="font-size:16px">Up for auction: <b>' + esc(p && p.name) + '</b> (' + (p && p.rating) + '). Top bid <b>' + d.lot.bid + '</b> by ' + esc(teamName(d.lot.bidder)) + '. Sold in ' + clock(d.lot.deadline) + '.</p>';
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
    if (d.type === 'auction') {
      out += '<p>' + T.teams.map(function (t) { return esc(t.name) + ': <b>' + d.budgets[t.id] + '</b> left'; }).join(' &middot; ') + '</p>';
    }
    var avail = T.signups.filter(function (p) { return !taken(p.id); }).sort(function (a, b) { return b.rating - a.rating; });
    var canAct = d.type === 'auction' ? (mineOnClock && !d.lot) : mineOnClock;
    out += '<h4>Available (' + avail.length + ')</h4><table class="table table-condensed"><tbody>' + avail.map(function (p) {
      return '<tr><td><a href="/profile/' + esc(p.id) + '">' + esc(p.name) + '</a></td><td class="text-right">' + p.rating + '</td><td class="text-right">'
        + (canAct ? (d.type === 'auction' ? btn('Nominate', { type: 'nominateFromBox', player: p.id }, 'btn-xs btn-primary') : btn('Pick', { type: 'pick', player: p.id }, 'btn-xs btn-primary')) : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
    return out;
  }

  function teams() {
    if (!T.teams.length) return '';
    var d = T.draft;
    return '<h3>Teams</h3><div style="display:flex;flex-wrap:wrap;gap:10px">' + T.teams.map(function (t, i) {
      var onClock = d && !d.done && d.onClock === t.id;
      return '<div class="panel panel-default" style="min-width:180px;flex:1 1 180px;margin:0' + (onClock ? ';border-color:#8BC34A' : '') + '"><div class="panel-heading"><b>' + esc(t.name) + '</b>'
        + (T.status !== 'signup' && T.status !== 'draft' ? ' <span style="opacity:.6">seed ' + (i + 1) + '</span>' : '')
        + (d && d.type === 'auction' && !d.done ? ' <span style="opacity:.7">(' + d.budgets[t.id] + ')</span>' : '') + '</div><div class="panel-body" style="padding:6px 10px">'
        + t.players.map(function (p) { return '<div>' + esc(p.name) + (p.id === t.captain ? ' <span class="label label-primary">C</span>' : '') + ' <span style="opacity:.6">' + p.rating + '</span></div>'; }).join('')
        + Array(Math.max(0, T.teamSize - t.players.length) + 1).join('<div style="opacity:.4">open</div>') + '</div></div>';
    }).join('') + '</div>';
  }

  function matchBox(m) {
    var side = function (s) {
      var id = m[s], won = m.done && m.winner === id && !m.bye;
      return '<div style="display:flex;justify-content:space-between;' + (won ? 'font-weight:bold;' : '') + (m.done && !won && !m.draw ? 'opacity:.6' : '') + '"><span>' + esc(teamName(id)) + '</span><span>' + (m.bye || id === null ? '' : m.wins[s]) + '</span></div>';
    };
    var out = '<div class="t-match" style="border:1px solid rgba(128,128,128,.4);border-radius:4px;padding:5px 8px;margin:6px 0;min-width:180px' + (m.live ? ';border-color:#03A9F4' : '') + '">'
      + '<div style="font-size:11px;opacity:.6">' + esc(m.label) + (m.bestOf > 1 ? ' &middot; best of ' + m.bestOf : '') + '</div>' + side('a') + side('b');
    if (m.bye) out += '<div style="font-size:11px;opacity:.6">bye</div>';
    if (m.forfeit) out += '<div style="font-size:11px;opacity:.6">decided by the organizer</div>';
    if (m.draw) out += '<div style="font-size:11px;opacity:.6">draw</div>';
    m.games.forEach(function (g, i) {
      out += '<div style="font-size:11px;opacity:.7">Game ' + (i + 1) + ': ' + g.score.a + '-' + g.score.b + (g.map ? ' on ' + esc(g.map) : '') + (g.counted ? '' : ' (tie, played again)') + (g.replay ? ' <a href="/game?replay=' + encodeURIComponent(g.replay) + '">replay</a>' : '') + '</div>';
    });
    if (m.note) out += '<div style="font-size:11px;color:#f0ad4e">' + esc(m.note) + '</div>';
    if (m.live) {
      var mine = myTeam(), playing = mine && (mine.id === m.a || mine.id === m.b);
      out += '<div style="margin-top:4px">' + (playing ? '<a class="btn btn-xs btn-primary" href="/competitive/' + T.id + '/play">Join game</a> ' : '<a class="btn btn-xs btn-default" href="/competitive/' + T.id + '/play?match=' + esc(m.id) + '">Watch</a> ')
        + (me.organizer ? btn('Cancel game', { type: 'cancelGame', match: m.id }, 'btn-xs btn-link') : '') + '</div>';
    } else if (m.playable && T.status === 'playing') {
      var caps = [team(m.a), team(m.b)];
      var myCap = caps.filter(function (t) { return t && t.captain === me.id; })[0];
      out += '<div style="font-size:11px;margin-top:4px">' + caps.map(function (t) { return esc(t.name) + (m.ready.indexOf(t.id) >= 0 ? ' ready' : ' not ready'); }).join(', ') + '</div><div>';
      if (myCap) out += m.ready.indexOf(myCap.id) >= 0 ? btn('Not ready', { type: 'ready', match: m.id, on: false }, 'btn-xs btn-default') : btn('Ready', { type: 'ready', match: m.id, on: true }, 'btn-xs btn-success');
      if (me.organizer) out += btn('Start now', { type: 'forceStart', match: m.id }, 'btn-xs btn-primary') + btn(esc(teamName(m.a)) + ' wins', { type: 'award', match: m.id, side: 'a' }, 'btn-xs btn-link', ' data-confirm="1"') + btn(esc(teamName(m.b)) + ' wins', { type: 'award', match: m.id, side: 'b' }, 'btn-xs btn-link', ' data-confirm="1"');
      out += '</div>';
    }
    return out + '</div>';
  }

  function bracket() {
    if (!T.matches.length) return '';
    var out = '';
    if (T.standings) {
      out += '<h3>Table</h3><table class="table table-condensed"><thead><tr><th>#</th><th>Team</th><th class="text-right">Played</th><th class="text-right">W-D-L</th><th class="text-right">Score</th><th class="text-right">Points</th></tr></thead><tbody>'
        + T.standings.map(function (r, i) {
          var cut = T.playoffTeams >= 2 && i === T.playoffTeams - 1 ? ' style="border-bottom:2px solid #8BC34A"' : '';
          return '<tr' + cut + '><td>' + (i + 1) + '</td><td>' + esc(teamName(r.team)) + '</td><td class="text-right">' + r.played + '</td><td class="text-right">' + r.wins + '-' + r.draws + '-' + r.losses + '</td><td class="text-right">' + r.for + '-' + r.against + '</td><td class="text-right"><b>' + r.points + '</b></td></tr>';
        }).join('') + '</tbody></table>'
        + (T.playoffTeams >= 2 ? '<p style="opacity:.7;margin-top:-10px">2 points for a win, 1 for a draw. The top ' + T.playoffTeams + ' go to the playoffs.</p>' : '<p style="opacity:.7;margin-top:-10px">2 points for a win, 1 for a draw. The top team wins.</p>');
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
    if (T.status === 'ready') out += btn('Start tournament', { type: 'start' }, 'btn-primary');
    out += btn('Delete tournament', { type: 'delete' }, 'btn-danger', ' data-confirm="1"') + '</p>';
    return out;
  }

  function render() {
    // keep typed numbers and focus across redraws
    var keep = {}, focus = document.activeElement && document.activeElement.id;
    root.querySelectorAll('input[id]').forEach(function (e) { keep[e.id] = e.value; });
    root.innerHTML = '<div id="t-error" class="alert alert-danger" style="display:none"></div>' + banner()
      + '<p><b>Status:</b> ' + ({ signup: 'sign ups open', draft: 'drafting', ready: 'teams set, waiting for the organizer to start', playing: 'in progress', done: 'finished' })[T.status] + '</p>'
      + (T.teamMode === 'draft' && T.status === 'signup' ? signups() : '') + draft() + teams() + bracket() + organizer();
    Object.keys(keep).forEach(function (id) { var e = document.getElementById(id); if (e && id !== 't-bid') e.value = keep[id]; });
    if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
  }

  root.addEventListener('change', function (e) {
    if (e.target.classList.contains('t-cap')) {
      captainPicks = [].map.call(root.querySelectorAll('.t-cap:checked'), function (x) { return x.value; });
    }
  });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var a = JSON.parse(b.getAttribute('data-act'));
    if (b.getAttribute('data-confirm') && !confirm(b.textContent.trim() + '?')) return;
    if (a.type === 'captainsFromBoxes') a = { type: 'captains', ids: captainPicks || [] };
    if (a.type === 'bidFromBox') a = { type: 'bid', amount: Number(document.getElementById('t-bid').value) };
    if (a.type === 'nominateFromBox') a = { type: 'nominate', player: a.player, bid: Number((document.getElementById('t-open') || {}).value || 1) };
    if (a.type === 'autoCaptains' || a.type === 'captains') captainPicks = null;
    act(a);
  });

  setInterval(function () { root.querySelectorAll('.t-clock').forEach(function (e) { e.textContent = secs(Number(e.getAttribute('data-deadline'))); }); }, 250);

  socket.on('connect', function () { socket.emit('watch', window.TOURNAMENT_ID); });
  socket.on('me', function (m) { me = m; });
  socket.on('state', function (s) {
    skew = s.now - Date.now();
    var wasSignup = T && T.status === 'signup';
    T = s;
    if (wasSignup && T.status !== 'signup') captainPicks = null;
    if (me.organizer && T.status === 'signup') captainPicks = captainPicks && captainPicks.filter(function (id) { return T.signups.some(function (p) { return p.id === id; }); });
    render();
  });
  socket.on('gone', function () { root.innerHTML = '<p>This tournament was deleted. <a href="/competitive">All tournaments</a></p>'; });
})();
