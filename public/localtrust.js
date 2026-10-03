// localtrust.js - client half of the "Local trust" group setting (ours, not part of the real
// client). The server adds it after global-game.js, with tagproConfig.localTrust set to the
// physics/tile constants (GameRoom.trustConfig), only for games where it's on. Uses the client's
// own mod hooks (tagpro.events, tagpro.socket, tagpro.world.syncPlayer).
//
// Your ball is simulated only here, like an offline game:
//  - movement keys apply immediately (the real client waits ping/2)
//  - boosts, team tiles / juke juice speed, your own bomb hits and portals are predicted here with
//    the server's own formulas (engine/game.js tileInteractions); the server just follows along
//  - the position is reported ~30 times a second; the server only overrides it with a hard snap
//    (spawn, death, rejected report), which carries directSet
//  - explosions caused by others arrive as 'ltKick' (a velocity change added to yours)
//  - gravity maps: jumps happen here on the up press (engine/game.js jump/groundContacts), and
//    landings use the server's restitution instead of gravity.js's bouncier one
(function () {
  var cfg = tagproConfig.localTrust;
  if (!cfg) return;
  tagpro.ready.after(function () {
    var sock = tagpro.socket, body = null, frame = 0;
    var hit = false;        // used a tile this frame: report now, so the server sees us on it
    var V = Box2D.Common.Math.b2Vec2, TILE = cfg.tile, R = cfg.R;
    var MOVE = { up: 1, down: 1, left: 1, right: 1 };
    var used = {};          // "x,y" -> time: tiles this client already used, until the server's tile update arrives
    var arrived = null;     // portal we came out of; re-arms once we roll off it
    var onPickups = {};     // boost/powerup/bomb tiles under the ball last frame: they only fire on the way in
    var PICKUP = { 5: 'boost', 14: 'boost', 15: 'boost', 6: 'powerup', 10: 'bomb' };
    var me = function () { return tagpro.players[tagpro.playerId]; };
    var G = cfg.gravity, jumps = G ? G.jumps : 0; // jumps: null = unlimited
    var playing = function () { return [tagpro.states.ACTIVE, tagpro.states.OVERTIME, tagpro.states.CLUTCH].indexOf(tagpro.state) >= 0; };

    var emit = sock.emit;
    sock.emit = function (ev, d) {
      emit(ev, d);
      if ((ev !== 'keydown' && ev !== 'keyup') || !d || !MOVE[d.k]) return;
      var p = me();
      // same bookkeeping as the client's delayed apply, which then sees it's already done
      if (p && (p.lastSync[d.k] == null || d.t > p.lastSync[d.k])) { p[d.k] = ev === 'keydown'; p.lastSync[d.k] = d.t; }
      if (G && ev === 'keydown' && d.k === 'up' && p && body && !p.dead && playing() && (jumps == null || jumps > 0)) {
        if (jumps != null) jumps--;
        var v = body.GetLinearVelocity();
        body.SetAwake(true);
        body.SetLinearVelocity(new V(v.x, v.y - G.jump));
      }
    };

    // landing on something below (a wall, or a player with that setting on) restores jumps
    var wm = new Box2D.Collision.b2WorldManifold();
    function groundCheck() {
      if (body.GetLinearVelocity().y <= -0.5) return; // still leaving the ground
      for (var ce = body.GetContactList(); ce; ce = ce.next) {
        var c = ce.contact;
        if (!c.IsTouching() || (ce.other.player && !G.playerReset)) continue;
        c.GetWorldManifold(wm);
        var ny = c.GetFixtureA().GetBody() === body ? wm.m_normal.y : -wm.m_normal.y; // normal from us to the other body
        if (ny > 0.5) { jumps = G.jumps; return; }
      }
    }

    // gravity.js gives walls and balls restitution 0.3; the server (fitted to real replays) uses 0
    var bouncy = null;
    function unbounce() {
      for (var b = tagpro.world._b2World.GetBodyList(); b; b = b.GetNext()) {
        if (b !== body && b.GetType() !== Box2D.Dynamics.b2Body.b2_staticBody) continue; // walls + our ball
        for (var fx = b.GetFixtureList(); fx; fx = fx.GetNext()) fx.SetRestitution(G.restitution);
      }
      bouncy = body;
    }

    var sync = tagpro.world.syncPlayer;
    tagpro.world.syncPlayer = function (p, snap) {
      if (!body || p.id !== tagpro.playerId || p.dead || !p.draw || (snap && p.directSet)) {
        if (p.id === tagpro.playerId) { used = {}; arrived = null; onPickups = {}; if (G) jumps = G.jumps; }
        return sync.apply(this, arguments);
      }
      p.sync = null; // our own ball: ignore the server's (older) idea of it
    };

    var kick = function (vx, vy) { if (!body) return; var v = body.GetLinearVelocity(); body.SetLinearVelocity(new V(v.x + vx, v.y + vy)); };
    sock.on('ltKick', function (d) { kick(d.vx, d.vy); });
    sock.on('ltBoost', function (power) { var p = me(); if (p && !p.dead && body) boost(p, power); });

    // engine/game.js boost(): keep the direction, set the larger axis to the boost speed
    function boost(p, power) {
      var v = body.GetLinearVelocity(), dx = v.x, dy = v.y;
      if (Math.hypot(dx, dy) < 1e-3) { dx = (p.right ? 1 : 0) - (p.left ? 1 : 0); dy = (p.down ? 1 : 0) - (p.up ? 1 : 0); }
      var m = Math.max(Math.abs(dx), Math.abs(dy));
      if (m < 1e-6) return;
      var k = cfg.boost * (power || 1) / m;
      body.SetLinearVelocity(new V(dx * k, dy * k));
    }

    // engine/game.js tileInteractions(), for the parts that move the ball
    function predict(p) {
      var pos = body.GetPosition(), h = TILE / 2, now = performance.now();
      var x0 = Math.floor((pos.x - R + h) / TILE), x1 = Math.floor((pos.x + R + h) / TILE);
      var y0 = Math.floor((pos.y - R + h) / TILE), y1 = Math.floor((pos.y + R + h) / TILE);
      var onTeamTile = false, onArrival = false, wasOn = onPickups;
      onPickups = {};
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        var col = tagpro.map[x], t = col && col[y];
        if (t == null) continue;
        var cx = x * TILE, cy = y * TILE, key = x + ',' + y;
        var center = Math.hypot(pos.x - cx, pos.y - cy);
        var edge = Math.hypot(pos.x - Math.max(cx - h, Math.min(pos.x, cx + h)), pos.y - Math.max(cy - h, Math.min(pos.y, cy + h)));
        var base = Math.floor(parseFloat(t));
        if (edge < R - 0.01 && !p.flag && ((base === 11 && p.team === 1) || (base === 12 && p.team === 2) || base === 23)) onTeamTile = true;
        if (key === arrived && center < R + cfg.touch.portal) onArrival = true;
        var kind = PICKUP[base];
        if (kind && center < R + cfg.touch[kind]) { onPickups[key] = 1; if (wasOn[key]) continue; } // respawned under us
        if (typeof t !== 'number' || (used[key] && now - used[key] < 1500)) continue; // used / respawning
        if ((t === 5 || (t === 14 && p.team === 1) || (t === 15 && p.team === 2)) && center < R + cfg.touch.boost) {
          used[key] = now; hit = true; boost(p, 1);
        } else if (t === 10 && center < R + cfg.touch.bomb) {
          used[key] = now; hit = true;
          var dx = pos.x - cx, dy = pos.y - cy, d = Math.hypot(dx, dy);
          if (d > 1e-6 && d < cfg.bombR) kick(dx / d * cfg.bombS * (cfg.bombR - d), dy / d * cfg.bombS * (cfg.bombR - d));
        } else if ((t === 13 || (t === 24 && p.team === 1) || (t === 25 && p.team === 2)) && cfg.portals[key] && key !== arrived && center < R + cfg.touch.portal) {
          var dest = cfg.portals[key];
          used[key] = now; hit = true; arrived = dest[0] + ',' + dest[1];
          body.SetPosition(new V(dest[0] * TILE, dest[1] * TILE));
          return;
        }
      }
      if (arrived && !onArrival) arrived = null;
      p.ac = cfg.ac + (p.jukeJuice ? cfg.jjAc : 0) + (onTeamTile ? cfg.teamAc : 0);
      p.ms = p.speed ? cfg.topMs : onTeamTile ? cfg.teamMs : cfg.ms;
    }

    tagpro.events.register({
      playerUpdate: function (p, b) { if (p.id === tagpro.playerId) body = b; },
      update: function () {
        var p = me();
        if (!body || !p || p.dead || !p.draw) return;
        predict(p);
        if (G) { if (bouncy !== body) unbounce(); groundCheck(); }
        if (++frame % 2 && !hit) return;
        hit = false;
        var pos = body.GetPosition(), v = body.GetLinearVelocity();
        emit('lt', { x: pos.x, y: pos.y, vx: v.x, vy: v.y, a: body.GetAngularVelocity(), ra: body.GetAngle(), e: p.lte || 0 });
      },
    });
  });
})();
