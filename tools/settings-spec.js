// settings-spec.js - every group setting as the group page offers it (label, control, choices), read
// from the real group page (server/pages/group.html), for the static site's launcher.
// Returns [{ key, label, section, type: 'select' | 'bool' | 'text' | 'number', options?: [[value, text]] }].
const fs = require('fs');
const path = require('path');

// not for a single-player game: multiplayer-only, or chosen elsewhere on the launcher
const SKIP = new Set(['map', 'mode', 'laps', 'server', 'groupName', 'discoverable', 'selfAssignment', 'analytics', 'noScript', 'localTrust', 'gravity', 'experimental']);
const GAME = [['time', 'Game Length'], ['overtime', 'Overtime'], ['caps', 'Capture Limit'], ['mercyRule', 'Mercy Rule']];
const TEAM = [['redTeamName', 'Red Team Name', 'text'], ['blueTeamName', 'Blue Team Name', 'text'], ['redTeamScore', 'Red Starting Score', 'number'], ['blueTeamScore', 'Blue Starting Score', 'number']];
// shown under their power-up on the group page
const AFTER = { powerupJukeJuice: ['powerupJukeJuiceDuration', 'Juke Juice Duration'], powerupTagPro: ['powerupTagproDuration', 'TagPro Duration'], powerupRollingBomb: ['powerupRollingBombDuration', 'Rolling Bomb Duration'] };
const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

module.exports = function settingsSpec() {
  const h = fs.readFileSync(path.join(__dirname, '..', 'server', 'pages', 'group.html'), 'utf8');
  // the Custom Settings picker: key -> label, in the page's order
  const picker = h.match(/<select class="form-control js-customize[^>]*>([\s\S]*?)<\/select>/)[1];
  const labels = [...picker.matchAll(/<option value="(\w+)">([^<]*)<\/option>/g)].map((m) => [m[1], text(m[2])]);
  // every control the leader edits
  const controls = new Map();
  for (const m of h.matchAll(/<select class="form-control js-socket-setting[^"]*" name="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    controls.set(m[1], { type: 'select', options: [...m[2].matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map((o) => [o[1], text(o[2])]) });
  }
  for (const m of h.matchAll(/<input type="checkbox" class="js-socket-setting" name="(\w+)">\s*([^<]*)/g)) controls.set(m[1], { type: 'bool', text: text(m[2]) });
  // labels inside "Experimental Settings": "Enabled - Kissing Flag Carriers", or a <label> before a select
  const exp = h.match(/<div class="checkbox" name="experimental">([\s\S]*?)<div class="form-group">/)[1];
  const expKeys = [];
  for (const m of exp.matchAll(/name="(\w+)">\s*Enabled - ([^<]*)|<label>([^<]*)<\/label>\s*<select[^>]*name="(\w+)"|<select[^>]*name="(stickyBallTimeout)"/g)) {
    if (m[1]) expKeys.push([m[1], text(m[2])]);
    else if (m[4]) expKeys.push([m[4], text(m[3])]);
    else expKeys.push([m[5], 'NF Handoff Timeout']);
  }
  const out = [];
  const add = (key, label, section, type) => {
    if (SKIP.has(key) || out.some((s) => s.key === key)) return;
    const c = controls.get(key);
    if (type) return out.push({ key, label, section, type });
    if (!c) throw new Error('group.html: no control for setting ' + key);
    out.push(c.type === 'select' ? { key, label, section, type: 'select', options: c.options } : { key, label, section, type: 'bool' });
  };
  for (const [k, l] of GAME) add(k, l, 'Game');
  for (const [k, l, t] of TEAM) add(k, l, 'Teams', t);
  for (const [k, l] of labels) {
    if (k === 'experimental') for (const [ek, el] of expKeys) add(ek, el, 'Experimental');
    else { add(k, l, 'Custom Settings'); if (AFTER[k]) add(AFTER[k][0], AFTER[k][1], 'Custom Settings'); }
  }
  return out;
};

if (require.main === module) console.log(module.exports().map((s) => `${s.section} | ${s.key} | ${s.label} | ${s.type}${s.options ? ' ' + s.options.length + ': ' + s.options.slice(0, 3).map((o) => o.join('=')).join(', ') : ''}`).join('\n'));
