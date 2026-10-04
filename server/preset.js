// preset.js - official TagPro group preset format, reverse-engineered from tagpro.koalabeast.com
// (October 2026) by generating and applying presets on the live group server. Bugs and quirks of the
// real server are kept on purpose so presets behave exactly the same here and there.
//
// Format: "gZ" + one entry per preset setting that differs from its default, in the order of ENTRIES.
// An entry is a one-letter key followed by its value. Numbers are base 52 over a-z A-Z (a=0 ... Z=51),
// most significant digit first, with a fixed width per setting. Booleans are the key alone (meaning
// "not the default"). See ENTRIES for each setting's key, width and scale.
const defaults = require('./groupDefaults.json');
const MAP_CODES = require('./presetMaps.json'); // map name -> 19-char code (opaque; captured from the real server)

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HEADER = 'gZ';
const DEFAULT_REGIONS = ['US East', 'US Central', 'US West', 'Europe', 'Oceanic'];
const REGION_CODES = { 'US East': 'e', 'US Central': 'c', 'US West': 'w', Europe: 'u', Oceanic: 'o' };
// eggball and ice hockey quietly switch the map to their own (it isn't broadcast as a setting change)
const MODE_MAPS = { eggball: 'eggball', iceHockey: '#iceHockey' };
const CODE_TO_MAP = Object.fromEntries(Object.entries(MAP_CODES).map(([k, v]) => [v, k]));

const b52 = (n, width) => {
  let s = '';
  for (let i = 0; i < width; i++) { s = ALPHA[n % 52] + s; n = Math.floor(n / 52); }
  return s;
};
const unb52 = (s) => [...s].reduce((n, c) => n * 52 + ALPHA.indexOf(c), 0);

// raw = the base-52 number in the preset; ok(raw) = whether the real server accepts it when applying
// (an out-of-range value leaves that setting as it was, without failing the preset).
const num = (key, width, toRaw, fromRaw, ok) => ({ kind: 'num', key, width, toRaw, fromRaw, ok });
const plain = (key, ok) => num(key, 1, (v) => v, (r) => r, ok);
const tenths = (key, ok) => num(key, 1, (v) => Math.round(v * 10), (r) => r / 10, ok);
const ms = (key, ok) => num(key, 3, (v) => Math.round(v / 100), (r) => r * 100, ok);
const between = (lo, hi) => (r) => r >= lo && r <= hi;
const bool = (key) => ({ kind: 'bool', key });
const choice = (key, codes) => ({ kind: 'enum', key, codes });

// Order matters: the real server writes entries in this order, whatever order they were changed in.
const ENTRIES = [
  ['map', { kind: 'map', key: 'M' }],
  ['mode', choice('g', { classic: 'c', eggball: 'e', iceHockey: 'i', gravity: 'g', racing: 'r' })],
  ['time', plain('t', between(0, 20))],
  ['caps', plain('c', between(0, 51))],
  ['laps', plain('A', between(1, 20))],
  ['overtime', bool('o')],
  ['overtimeRespawnIncrement', ms('i', between(0, 100))],
  ['overtimeJukeJuice', bool('J')],
  ['rollingBombBehavior', { kind: 'flag', key: 'B', on: 'classic' }],
  ['mercyRule', plain('y', between(0, 51))],
  ['accel', tenths('a', between(0, 30))],
  ['topspeed', tenths('e', between(0, 30))],
  ['bounce', tenths('N', between(0, 30))],
  ['playerRespawnTime', ms('r', between(0, 36000))],
  ['speedPadRespawnTime', ms('s', between(0, 36000))],
  ['dynamiteRespawnTime', ms('m', between(0, 36000))],
  ['powerupRespawnTime', ms('u', between(0, 36000))],
  ['powerupJukeJuiceDuration', ms('V', between(0, 36000))],
  ['powerupRollingBombDuration', ms('U', between(0, 36000))],
  ['powerupTagproDuration', ms('Z', between(0, 36000))],
  ['potatoTime', num('O', 3, (v) => Math.round(v / 1000), (r) => r * 1000, between(0, 180))],
  ['powerupDelay', bool('d')],
  ['lastPossession', choice('I', { disabled: 'd', always: 'a', tied: 't', winnable: 'w', tiedOrWinnable: 'o' })],
  ['ghostMode', choice('H', { disabled: 'd', noPlayerCollisions: 'p', noTeamCollisions: 't', noEnemyCollisions: 'e', noMarsBallCollisions: 'm', noPlayerOrMarsCollisions: 'n' })],
  ['poosts', bool('z')],
  ['kissingFCs', bool('k')],
  ['kissingTPs', bool('K')],
  ['jukeJuiceBoost', bool('S')],
  ['jukeJuiceBoostPower', num('P', 1, (v) => Math.round(v / 5), (r) => r * 5, between(0, 51))],
  ['rollingBombForceMultipler', tenths('f', between(0, 30))],
  ['rollingBombDistanceMultipler', tenths('l', between(0, 30))],
  ['spacebarDetonateAll', bool('D')],
  ['tagproMaxTags', plain('X', between(0, 51))],
  ['gravityWellForce', num('Q', 1, (v) => Math.round((v + 3) * 4), (r) => r / 4 - 3, between(0, 24))],
  ['analytics', bool('Y')],
  ['noScript', bool('C')],
  ['powerupJukeJuice', bool('j')],
  ['powerupTagPro', bool('T')],
  ['powerupRollingBomb', bool('b')],
  ['eggballLosingTeamStarts', bool('L')],
  ['combinejjrb', bool('n')],
  ['jumpLimit', plain('p', between(0, 51))],
  ['speedLimit', bool('E')],
  ['isPlayerJumpResetEnabled', bool('F')],
  ['mapTestingMode', bool('G')],
  ['respawnWarnings', bool('w')],
  ['pupIndicators', bool('x')],
  ['stickyBallFix', choice('R', { none: 'n', existingContact: 'e', full: 'f' })],
  ['stickyBallTimeout', num('W', 1, (v) => Math.round(v / 250), (r) => r * 250, between(1, 4))],
  ['server', { kind: 'server', key: 'q' }],
  ['regions', { kind: 'regions', key: 'v' }],
];
const BY_KEY = Object.fromEntries(ENTRIES.map(([name, e]) => [e.key, [name, e]]));
const DEFAULTS = Object.fromEntries(defaults.settings);

// Strict comparison, like the real server: the three powerup durations default to the STRING "20000",
// and once a leader sets them they become numbers, so setting 20 seconds by hand still shows up ("VadS").
const isDefault = (name, v) => v === DEFAULTS[name];

// settings: a group's settings. modeMap: the hidden map eggball/ice hockey switched to (or null).
function encode(settings, modeMap) {
  let out = '';
  for (const [name, e] of ENTRIES) {
    const v = settings[name];
    if (e.kind === 'map') {
      const map = modeMap || v;
      if (!map || map === 'random') continue;
      if (map === 'random_ctf' || map === 'random_nf') { out += map; continue; } // written raw, no key (real server bug)
      let body;
      if (String(map).startsWith('fm_id/')) {
        const id = parseInt(map.slice(6), 10);
        if (!(id >= 0)) continue;
        let w = 1; while (52 ** w <= id) w++;
        body = 'f' + b52(id, w);
      } else if (map === '#iceHockey') body = 'iceCeJmXorbGHmpbbrX';
      else if (MAP_CODES[map]) body = MAP_CODES[map];
      else continue; // a map with no known code (local or uploaded) isn't saved
      out += 'M' + ALPHA[body.length] + body;
    } else if (e.kind === 'server') {
      if (!settings.serverSelect || !v) continue;
      const srv = defaults.servers.find((s) => s.value === v);
      if (srv) out += 'q' + srv.key;
    } else if (e.kind === 'regions') {
      if (settings.serverSelect && settings.server) continue; // a chosen server makes regions irrelevant
      const r = Array.isArray(v) ? v : [];
      if (DEFAULT_REGIONS.every((x) => r.includes(x))) continue; // all five, any order
      out += 'v' + ALPHA[r.length] + r.map((x) => REGION_CODES[x] || '').join('');
    } else if (isDefault(name, v) || v === undefined) continue;
    else if (e.kind === 'bool') out += e.key;
    else if (e.kind === 'flag') out += e.key;
    else if (e.kind === 'enum') out += e.key + (e.codes[v] || '');
    else out += e.key + b52(e.toRaw(Number(v)), e.width);
  }
  return out ? HEADER + out : '';
}

// Parse a preset (or a ".../groups/create?preset=..." link). Returns { name: value } for the entries it
// holds, or null if the real server would reject it ("This is not a valid Group Preset.").
function parse(input) {
  let p = String(input == null ? '' : input).trim();
  if (p.includes('preset=')) p = p.split('preset=')[1];
  if (!p.startsWith(HEADER) || p.length === HEADER.length) return null;
  const out = {};
  let i = HEADER.length;
  while (i < p.length) {
    // random CTF / NF are written without a key and the real server can't read them back (kept as is)
    if (p.startsWith('random_', i)) return null;
    const k = p[i++];
    const hit = BY_KEY[k];
    if (!hit) return null;
    const [name, e] = hit;
    if (e.kind === 'bool') out[name] = !DEFAULTS[name];
    else if (e.kind === 'flag') out[name] = e.on;
    else if (e.kind === 'enum') {
      const v = Object.keys(e.codes).find((x) => e.codes[x] === p[i]);
      if (!v) return null;
      out[name] = v; i++;
    } else if (e.kind === 'num') {
      // a value cut short by the end of the string reads as whatever digits are there ("gZt" = 0 minutes)
      const raw = unb52(p.slice(i, i + e.width)); i += Math.min(e.width, p.length - i);
      out[name] = { raw, value: e.fromRaw(raw) };
    } else if (e.kind === 'map') {
      const len = ALPHA.indexOf(p[i++]);
      const body = p.slice(i, i + len); i += len;
      if (body.length !== len || len < 1) return null;
      if (body[0] === 'f') {
        const id = unb52(body.slice(1));
        if (body.length < 2 || id < 1) return null; // Fortunate Maps id 0 is refused
        out.map = 'fm_id/' + id;
      } else if (body === 'iceCeJmXorbGHmpbbrX') out.map = '#iceHockey';
      else if (CODE_TO_MAP[body]) out.map = CODE_TO_MAP[body];
      else return null;
    } else if (e.kind === 'server') {
      const key = p.slice(i, i + 2); i += 2;
      if (key.length !== 2) return null;
      const srv = defaults.servers.find((s) => s.key === key);
      out.server = srv ? srv.value : undefined; // an unknown server is ignored
    } else if (e.kind === 'regions') {
      // count letter then one letter per region; a missing count means none ("gZv" = no regions)
      const n = i < p.length ? ALPHA.indexOf(p[i++]) : 0;
      const codes = p.slice(i, i + n); i += n;
      if (n < 0 || codes.length !== n) return null;
      const names = [...codes].map((c) => Object.keys(REGION_CODES).find((r) => REGION_CODES[r] === c));
      out.regions = names.includes(undefined) ? null : names; // an unknown letter: accepted, regions untouched
    }
  }
  return out;
}

// Apply a parsed preset to settings the way the real server does: every preset setting goes back to its
// default unless the preset sets it; a numeric value out of range leaves that one setting unchanged;
// settings presets don't carry (group name, privacy, team names and scores, self assignment) are untouched.
// Returns { changed: [names], modeMap }.
function apply(settings, parsed) {
  const changed = [];
  // loose comparison, like the real server: a duration still at the string "20000" isn't touched by a
  // reset to the number 20000, but one that was changed comes back as the number (and so stays in presets)
  const set = (name, v) => {
    if (JSON.stringify(settings[name]) === JSON.stringify(v)) return;
    settings[name] = v; changed.push(name);
  };
  const reset = (name, v) => { if (settings[name] != v) set(name, v); }; // eslint-disable-line eqeqeq
  const def = (name) => (/^powerup\w+Duration$/.test(name) ? Number(DEFAULTS[name]) : DEFAULTS[name]);
  for (const [name, e] of ENTRIES) {
    const got = parsed[name];
    if (e.kind === 'map') { if (got !== undefined) set('map', got); else reset('map', 'random'); }
    else if (e.kind === 'server') {
      if (got) { set('serverSelect', true); set('server', got); } else { reset('serverSelect', DEFAULTS.serverSelect); reset('server', DEFAULTS.server); }
    } else if (e.kind === 'regions') {
      if (parsed.server) set('regions', []);
      else if (got === undefined) set('regions', DEFAULTS.regions.slice());
      else if (got) set('regions', got); // null = an unknown region letter: regions left as they were
    } else if (e.kind === 'num') {
      if (got === undefined) reset(name, def(name));
      else if (e.ok(got.raw)) set(name, got.value);
    } else if (got !== undefined) set(name, got);
    else reset(name, DEFAULTS[name]);
  }
  // the mode is applied after the map, so eggball / ice hockey replace any map the preset chose
  const modeMap = MODE_MAPS[settings.mode] || null;
  return { changed, modeMap };
}

module.exports = { encode, parse, apply, ENTRIES, MODE_MAPS, b52, unb52 };
