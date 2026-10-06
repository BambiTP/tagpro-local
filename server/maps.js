// maps.js - the maps/ folder: listing, reading and checking maps (used by games.js and local.js).
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { loadMap, trimPng } = require('../engine/mapLoader');

const MAPS_DIR = path.join(__dirname, '..', 'maps');

// ---- maps: maps/<key>.png + maps/<key>.json ; key is a Fortunate Maps id or a name ----
function mapKeys() {
  return fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
    .filter((k) => fs.existsSync(path.join(MAPS_DIR, k + '.json')));
}

// a map image's size from its PNG header, checked before decoding (a 2 MB file can decode to gigabytes)
const MAX_MAP_TILES = 256; // real maps are well under 100 x 100
function checkPngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new MapError('That map image is not a PNG.');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w > MAX_MAP_TILES || h > MAX_MAP_TILES) throw new MapError(`That map is ${w} x ${h} tiles; the most is ${MAX_MAP_TILES} x ${MAX_MAP_TILES}.`);
}

function readMap(key) {
  const file = fs.readFileSync(path.join(MAPS_DIR, key + '.png'));
  checkPngSize(file);
  const png = PNG.sync.read(trimPng(file));
  const json = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, key + '.json'), 'utf8'));
  return loadMap(png, json);
}

// a team with no spawn points and no flag has nowhere to spawn: such a map can't be played
// (eggball spawns players its own way)
class MapError extends Error {}
function checkSpawns(room) {
  if (!room.egg && [1, 2].some((t) => !room.spawnTiles[t].length)) throw new MapError(`The map "${room.mapName}" has no valid spawns, so it can't be played.`);
}

function rotationKeys() {
  const f = path.join(MAPS_DIR, 'rotation.json');
  const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const all = mapKeys().filter((k) => !k.startsWith('upload-'));
  const keys = list ? list.map(String).filter((k) => all.includes(k)) : all;
  return keys.length ? keys : all;
}

module.exports = { MAPS_DIR, mapKeys, checkPngSize, readMap, MapError, checkSpawns, rotationKeys };
