// admin.js - admin control panel (/admin) for public (Play Now) games: map, rotation, settings,
// queue size. Admins are usernames listed in data/admins.json (tools/make-admin.js adds one).
const fs = require('fs');
const path = require('path');
const defaults = require('./groupDefaults.json');
const { esc } = require('./pages');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'public-settings.json');
const ADMINS = path.join(DATA, 'admins.json');
const MAPS = path.join(__dirname, '..', 'maps');

// group settings that don't apply to a public game
const SKIP = new Set(['isPrivate', 'discoverable', 'serverSelect', 'allowPlayers', 'map', 'mapId', 'laps', 'selfAssignment',
  'analytics', 'noScript', 'eggballLosingTeamStarts', 'server', 'name', 'regions', 'groupId', 'stickyBallFix', 'stickyBallTimeout', 'speedLimit']);
const CHOICES = {
  mode: ['classic', 'gravity'],
  rollingBombBehavior: ['default', 'classic'],
  lastPossession: ['disabled', 'always', 'tied', 'winnable', 'tiedOrWinnable'],
  ghostMode: ['disabled', 'noPlayerCollisions', 'noTeamCollisions', 'noEnemyCollisions', 'noMarsBallCollisions', 'noPlayerOrMarsCollisions'],
};
const LABELS = {
  time: 'Time limit (minutes)', caps: 'Cap limit (0 = none)', mercyRule: 'Mercy rule (cap lead, 0 = off)', overtime: 'Overtime',
  overtimeRespawnIncrement: 'OT respawn increment (ms per pop)', overtimeJukeJuice: 'Overtime juke juice', mode: 'Mode',
  accel: 'Acceleration multiplier', topspeed: 'Top speed multiplier', bounce: 'Bounciness multiplier',
  playerRespawnTime: 'Player respawn (ms)', speedPadRespawnTime: 'Boost respawn (ms)', dynamiteRespawnTime: 'Bomb respawn (ms)',
  powerupRespawnTime: 'Powerup respawn (ms)', powerupJukeJuiceDuration: 'Juke juice duration (ms)',
  powerupRollingBombDuration: 'Rolling bomb duration (ms)', powerupTagproDuration: 'TagPro duration (ms)',
  redTeamName: 'Red team name', blueTeamName: 'Blue team name', redTeamScore: 'Red starting score', blueTeamScore: 'Blue starting score',
  potatoTime: 'Potato timer (ms, 0 = off)', powerupDelay: 'Delay first powerups one cycle', lastPossession: 'Clutch time (last possession)',
  ghostMode: 'Ghost mode', poosts: 'Pop/portal boosts', kissingFCs: 'Kissing flag carriers', kissingTPs: 'Kissing TagPros',
  jukeJuiceBoost: 'Juke juice spacebar boost', jukeJuiceBoostPower: 'Juke juice boost power (%)',
  rollingBombForceMultipler: 'Rolling bomb force multiplier', rollingBombDistanceMultipler: 'Rolling bomb distance multiplier',
  spacebarDetonateAll: 'Spacebar uses all powerups', tagproMaxTags: 'TagPro max tags (0 = unlimited)', gravityWellForce: 'Gravity well force',
  powerupJukeJuice: 'Juke juice', powerupTagPro: 'TagPro', powerupRollingBomb: 'Rolling bomb', combinejjrb: 'Combine juke juice + rolling bomb',
  jumpLimit: 'Gravity: jumps (51 = unlimited)', isPlayerJumpResetEnabled: 'Gravity: landing on players resets jumps',
  mapTestingMode: 'Map testing mode', respawnWarnings: 'Respawn warnings', pupIndicators: 'Next powerup indicators', disableAllPups: 'Disable all powerups',
};
const FIELDS = defaults.settings.filter(([k]) => !SKIP.has(k));
const DEFAULT_VALUES = Object.fromEntries(FIELDS);

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
let state = read(FILE, null) || { settings: {}, map: 'random', rotation: null, gameSize: 8 };
const save = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(FILE + '.tmp', FILE); };

function isAdmin(session) {
  if (!session || !session.account) return false;
  const list = read(ADMINS, []);
  return list.map((u) => String(u).toLowerCase()).includes(session.account.username.toLowerCase());
}

// installed maps: key -> name (rotation.json defines the default pool)
function installedMaps() {
  const pool = read(path.join(MAPS, 'rotation.json'), []);
  const out = [];
  for (const f of fs.readdirSync(MAPS)) {
    if (!f.endsWith('.json') || f === 'rotation.json' || f.startsWith('upload-') || f === 'manifest.json') continue;
    const key = f.slice(0, -5);
    if (!fs.existsSync(path.join(MAPS, key + '.png'))) continue;
    try { out.push({ key, name: read(path.join(MAPS, f), {}).info.name || key, inRotation: pool.includes(key) }); } catch (e) { /* skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- used by the queue ----
function publicSettings() { return Object.assign({}, DEFAULT_VALUES, state.settings); }
function gameSize() { const n = Number(state.gameSize); return Number.isInteger(n) && n >= 2 && n <= 16 && n % 2 === 0 ? n : 8; }
function mapChoice() { return state.map || 'random'; }
function rotationPool() { return Array.isArray(state.rotation) && state.rotation.length ? state.rotation : null; }

function coerce(key, raw) {
  const def = DEFAULT_VALUES[key];
  if (typeof def === 'boolean') return raw === 'on' || raw === 'true';
  if (typeof def === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : def; }
  if (CHOICES[key]) return CHOICES[key].includes(raw) ? raw : def;
  return String(raw == null ? def : raw).slice(0, 40);
}

function update(body) {
  const settings = {};
  for (const [key] of FIELDS) settings[key] = coerce(key, body[key]);
  // keep only values that differ from the public defaults
  state.settings = Object.fromEntries(Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULT_VALUES[k])));
  const keys = new Set(installedMaps().map((m) => m.key));
  state.map = body.map === 'random' || keys.has(body.map) ? body.map : 'random';
  const rot = [].concat(body.rotation || []).filter((k) => keys.has(k));
  state.rotation = rot.length ? rot : null;
  const n = Number(body.gameSize);
  state.gameSize = [2, 4, 6, 8, 10, 12, 14, 16].includes(n) ? n : 8;
  save();
}

function reset() { state = { settings: {}, map: 'random', rotation: null, gameSize: 8 }; save(); }

function panel(message) {
  const cur = publicSettings();
  const maps = installedMaps();
  const pool = new Set(rotationPool() || maps.filter((m) => m.inRotation).map((m) => m.key));
  const input = (key) => {
    const v = cur[key], label = esc(LABELS[key] || key);
    if (typeof DEFAULT_VALUES[key] === 'boolean') return `<div class="checkbox"><label><input type="checkbox" name="${key}" ${v ? 'checked' : ''}> ${label}</label></div>`;
    if (CHOICES[key]) return `<div class="form-group"><label>${label}</label><select class="form-control" name="${key}">${CHOICES[key].map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('')}</select></div>`;
    const type = typeof DEFAULT_VALUES[key] === 'number' || /^\d+$/.test(String(DEFAULT_VALUES[key])) ? 'number" step="any' : 'text';
    return `<div class="form-group"><label>${label}</label><input class="form-control" type="${type}" name="${key}" value="${esc(v)}"></div>`;
  };
  const changed = Object.keys(state.settings).length;
  return `<h1>Admin</h1>
    <p style="opacity:.75">Public games (Play Now). Changes apply to the next game that starts.</p>
    ${message ? `<div class="alert alert-success">${esc(message)}</div>` : ''}
    <form method="post" action="/admin">
      <h3>Map</h3>
      <div class="form-group"><select class="form-control" name="map">
        <option value="random" ${mapChoice() === 'random' ? 'selected' : ''}>Random from rotation (below)</option>
        ${maps.map((m) => `<option value="${esc(m.key)}" ${mapChoice() === m.key ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></div>
      <details><summary style="cursor:pointer">Rotation (${pool.size} of ${maps.length} maps)</summary>
        <div style="columns:2;margin-top:8px">${maps.map((m) => `<div class="checkbox" style="margin:2px 0"><label><input type="checkbox" name="rotation" value="${esc(m.key)}" ${pool.has(m.key) ? 'checked' : ''}> ${esc(m.name)}</label></div>`).join('')}</div>
      </details>
      <h3>Queue</h3>
      <div class="form-group"><label>Players per game</label><select class="form-control" name="gameSize">
        ${[2, 4, 6, 8, 10, 12, 14, 16].map((n) => `<option value="${n}" ${n === gameSize() ? 'selected' : ''}>${n} (${n / 2}v${n / 2})</option>`).join('')}
      </select></div>
      <h3>Game settings <small>${changed ? `${changed} changed from default` : 'all default'}</small></h3>
      ${FIELDS.map(([k]) => input(k)).join('\n')}
      <hr><div class="text-center"><button class="btn btn-primary" type="submit">Save</button></div>
    </form>
    <form method="post" action="/admin/reset" class="text-center" style="margin-top:10px" onsubmit="return confirm('Reset all public game settings to default?')">
      <button class="btn btn-default" type="submit">Reset to defaults</button>
    </form>`;
}

module.exports = { isAdmin, panel, update, reset, publicSettings, gameSize, mapChoice, rotationPool };
