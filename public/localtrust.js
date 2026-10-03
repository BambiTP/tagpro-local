// localtrust.js - client half of the "Local trust" group setting (ours, not part of the real
// client). The server adds it after global-game.js, with tagproConfig.localTrust set, only for
// games where it's on. Uses the client's own mod hooks (tagpro.events, tagpro.socket,
// tagpro.world.syncPlayer):
//  - movement keys apply to your ball immediately (the real client waits ping/2)
//  - your ball's position/velocity is reported to the server ~30 times a second
//  - server corrections for your own ball are ignored, except velocity changes the server causes
//    (boosts, bombs) and hard snaps (spawn, portal, rejected report), which carry directSet
(function () {
  tagpro.ready.after(function () {
    var sock = tagpro.socket, on = !!tagproConfig.localTrust, body = null, frame = 0;
    var MOVE = { up: 1, down: 1, left: 1, right: 1 };
    var me = function () { return tagpro.players[tagpro.playerId]; };

    var emit = sock.emit;
    sock.emit = function (ev, d) {
      emit(ev, d);
      if (!on || (ev !== 'keydown' && ev !== 'keyup') || !d || !MOVE[d.k]) return;
      var p = me();
      // same bookkeeping as the client's delayed apply, which then sees it's already done
      if (p && (p.lastSync[d.k] == null || d.t > p.lastSync[d.k])) { p[d.k] = ev === 'keydown'; p.lastSync[d.k] = d.t; }
    };

    var sync = tagpro.world.syncPlayer;
    tagpro.world.syncPlayer = function (p, snap) {
      if (!on || !body || p.id !== tagpro.playerId || p.dead || !p.draw || (snap && p.directSet)) return sync.apply(this, arguments);
      p.sync = null;
      if (p.lx != null && p.ly != null) body.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(p.lx, p.ly));
      if (p.a != null) body.SetAngularVelocity(p.a);
    };

    tagpro.events.register({
      playerUpdate: function (p, b) { if (p.id === tagpro.playerId) body = b; },
      update: function () {
        var p = me();
        if (!on || !body || !p || p.dead || !p.draw || ++frame % 2) return;
        var pos = body.GetPosition(), v = body.GetLinearVelocity();
        emit('lt', { x: pos.x, y: pos.y, vx: v.x, vy: v.y, a: body.GetAngularVelocity(), ra: body.GetAngle(), e: p.lte || 0 });
      },
    });
  });
})();
