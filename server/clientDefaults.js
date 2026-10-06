// clientDefaults.js - display defaults the single-player versions (local.js, the static site) change
// in the real client. The client sets each display setting's cookie only when it's missing, so a
// player's own choice on the Settings page still wins.
// WebGL off: the canvas renderer ran at 60 fps where WebGL got 25 on a player's laptop.
const CANVAS_DEFAULT = ['a("forceCanvasRenderer","false")', 'a("forceCanvasRenderer","true")'];

module.exports = { CANVAS_DEFAULT };
