// settings.js - the group settings a replay was played with. GLTP runs use the leaderboard's preset
// for the map (BambiTP/GLTP src/presets.json + map_metadata.json, copied into ./gltp); ranked and
// public games use the public defaults.
const path = require('path');
const preset = require('../../server/preset');
const defaults = Object.fromEntries(require('../../server/groupDefaults.json').settings);
const meta = require('./gltp/map_metadata.json');
const { fmId } = require('./maps');

const byId = {}, byName = {};
for (const [id, m] of Object.entries(meta)) {
  byId[id] = m;
  for (const e of m.equivalent_map_ids || []) byId[e] = byId[e] || m;
  byName[m.map_name] = m;
}

function gltpEntry(rep) {
  const id = fmId(rep);
  return (id && byId[id]) || byName[rep.meta && rep.meta.mapName] || null;
}

function settingsFor(rep) {
  if (!rep.groupId && !(rep.meta && rep.meta.private)) return {};
  const m = gltpEntry(rep);
  if (!m || !m.preset) return {};
  const parsed = preset.parse(m.preset);
  if (!parsed) return {};
  const s = Object.assign({}, defaults);
  preset.apply(s, parsed);
  delete s.map;
  return s;
}

module.exports = { settingsFor, gltpEntry };
