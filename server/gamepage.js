// gamepage.js - fills in the real game page for a room: the chosen texture pack and the extra
// scripts/assets a mode needs (eggball, gravity, local trust). Used by index.js and local.js.
const fs = require('fs');
const path = require('path');
const pages = require('./pages');
const { EGG_CLIENT_INFO } = require('../engine/game');

const PUBLIC = path.join(__dirname, '..', 'public');

// ---- texture packs: the real picker stores the chosen pack (image URLs) in the "textures"
// cookie; game/replay pages are rendered with those images. Default matches the real site.
const PACKS = require(path.join(__dirname, '..', 'ref-data', 'texture-packs.json'));
const DEFAULT_PACK = PACKS.find((p) => p.name === "Muscle's Cup Gradients") || PACKS[0];
const ASSET_IDS = { tiles: 'tiles', splats: 'splats', speedpad: 'speedpad', speedpadRed: 'speedpadred', speedpadBlue: 'speedpadblue', portal: 'portal', portalRed: 'portalred', portalBlue: 'portalblue' };
const okUrl = (u) => typeof u === 'string' && (/^\/textures\/[\w-]+\/[\w-]+\.png$/.test(u) || /^https:\/\/[^"'<>\s]+$/.test(u));
// pack: an account's saved pack, else null to use the "textures" cookie
function chosenPack(cookies, pack) {
  if (!pack) { try { pack = JSON.parse(cookies.textures || 'null'); } catch (e) { pack = null; } }
  return pack && typeof pack === 'object' ? pack : DEFAULT_PACK;
}
function withTextures(pack, page) {
  for (const [key, id] of Object.entries(ASSET_IDS)) {
    const url = okUrl(pack[key]) ? pack[key] : DEFAULT_PACK[key];
    page = page.replace(new RegExp(`(<img id="${id}" src=")[^"]*(")`), `$1${pages.esc(url)}$2`);
  }
  return page;
}

// eggball (an event mode): like the real site, the game page itself carries the event's script,
// tile/splat textures, images and sounds (the live client ignores clientInfo's event lists)
const CB = '/R-62bb0909b74c-z';
function eggballPage(h) {
  const ci = EGG_CLIENT_INFO;
  for (const [id, src] of Object.entries(ci.eventTextures)) h = h.replace(new RegExp(`(<img id="${id}" src=")[^"]*(")`), `$1${CB + src}$2`);
  const assets = ci.eventGraphics.map((g) => `\n        <img id="${g.id}" src="${CB + g.src}" class="asset">`).join('')
    + ci.eventSounds.map((a) => `\n        <audio id="${a.id}" preload="auto">` + ['mp3', 'm4a', 'ogg'].map((e) => `<source src="${CB + a.src}.${e}" type="audio/${e}">`).join('') + '</audio>').join('');
  return h.replace('<div id="assets">', '<div id="assets">' + assets);
}

// the game page for `room` (rendered game.html): mode scripts and assets added
function forRoom(room, h) {
  const GG = '<script src="/R-62bb0909b74c-z/compact/global-game.js"></script>';
  const extra = (room.egg ? EGG_CLIENT_INFO.eventScripts.map((p) => `\n        <script src="${CB + p}"></script>`).join('') : '')
    + (room.gravity ? '\n        <script src="/R-62bb0909b74c-z/scripts/gravity.js"></script>' : '')
    + (room.localTrust ? '\n        <script>tagproConfig.localTrust = ' + JSON.stringify(room.trustConfig()).replace(/</g, '\\u003c') + ';</script><script src="/localtrust.js?v=' + Math.floor(fs.statSync(path.join(PUBLIC, 'localtrust.js')).mtimeMs) + '"></script>' : '');
  return (room.egg ? eggballPage(h) : h).replace(GG, GG + extra);
}

module.exports = { PACKS, DEFAULT_PACK, chosenPack, withTextures, forRoom };
