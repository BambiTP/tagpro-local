// maps.js - finds the map logic (portals, buttons, gates, spawns) for a replay. The replay's "map"
// packet has the tiles but not the wiring, which lives in the Fortunate Maps JSON.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIRS = [path.join(ROOT, 'maps'), path.join(__dirname, 'fm-cache')];

let byName = null;
function nameIndex() {
  if (byName) return byName;
  byName = {};
  for (const d of DIRS) for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
    if (!f.endsWith('.json')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(d, f))); const n = j.info && j.info.name; if (n && !byName[n]) byName[n] = path.join(d, f); } catch (e) { /* skip */ }
  }
  return byName;
}

function fmId(rep) {
  const m = rep.clientInfo && /^fm_id\/(\d+)$/.exec(rep.clientInfo.mapfile || '');
  return m ? m[1] : null;
}

function findMapLogic(rep) {
  const id = fmId(rep);
  if (id) for (const d of DIRS) { const f = path.join(d, id + '.json'); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f)); }
  const name = rep.map && rep.map.info && rep.map.info.name;
  const f = name && nameIndex()[name];
  return f ? JSON.parse(fs.readFileSync(f)) : null;
}

module.exports = { findMapLogic, fmId };

// Does the map logic fit the replay's tiles? Every portal/button/gate the logic names must be that
// kind of tile in the replay, and every portal/button tile in the replay must be in the logic.
const kindOf = (v) => { const b = Math.floor(parseFloat(v)); return [13, 24, 25].includes(b) ? 'portal' : b === 8 ? 'button' : b === 9 ? 'gate' : null; };
function logicMismatches(rep, logic) {
  const T = rep.map.tiles, out = [];
  const at = (k) => { const [x, y] = k.split(',').map(Number); return T[x] && T[x][y]; };
  for (const k of Object.keys(logic.portals || {})) if (kindOf(at(k)) !== 'portal') out.push('portal ' + k);
  for (const k of Object.keys(logic.switches || {})) if (kindOf(at(k)) !== 'button') out.push('button ' + k);
  for (const k of Object.keys(logic.fields || {})) if (kindOf(at(k)) !== 'gate') out.push('gate ' + k);
  for (let x = 0; x < T.length; x++) for (let y = 0; y < T[x].length; y++) {
    const kd = kindOf(T[x][y]), k = x + ',' + y;
    if (kd === 'portal' && !(logic.portals || {})[k]) out.push('missing portal ' + k);
    if (kd === 'button' && !(logic.switches || {})[k]) out.push('missing button ' + k);
  }
  return out;
}

// Portal destinations seen in the replay: a "bomb" type 3 at D followed by a directSet to D means
// the ball went through the active portal closest to where it last was.
function observedPortals(rep) {
  const T = rep.map.tiles, last = {}, seen = {};
  let flash = null;
  for (const e of rep.events) {
    if (e.kind === 'bomb' && e.type === 3) { flash = e; continue; }
    if (e.kind !== 'p') continue;
    for (const x of e.u) {
      const d = x.delta;
      if (d.directSet && flash && e.t - flash.t < 40 && Math.abs(d.rx - flash.x) < 0.01 && Math.abs(d.ry - flash.y) < 0.01 && last[d.id]) {
        const [lx0, ly0, vx0, vy0, t0] = last[d.id], dt = (flash.t - t0) / 1000;
        const px = lx0 + vx0 * dt, py = ly0 + vy0 * dt; // where the ball was when it teleported
        let best = null, bd = 1.6;
        for (let tx = Math.max(0, Math.round(px / 0.4) - 4); tx <= Math.round(px / 0.4) + 4 && tx < T.length; tx++)
          for (let ty = Math.max(0, Math.round(py / 0.4) - 4); ty <= Math.round(py / 0.4) + 4 && ty < T[0].length; ty++) {
            if (kindOf(T[tx][ty]) !== 'portal') continue;
            const dd = Math.hypot(tx * 0.4 - px, ty * 0.4 - py);
            if (dd < bd) { bd = dd; best = tx + ',' + ty; }
          }
        if (best) (seen[best] || (seen[best] = {}))[Math.round(flash.x / 0.4) + ',' + Math.round(flash.y / 0.4)] = true;
      }
      if (x.full.rx != null && !x.full.dead && !d.directSet) last[d.id] = [x.full.rx, x.full.ry, x.full.lx || 0, x.full.ly || 0, e.t];
    }
  }
  const out = {};
  for (const [k, ds] of Object.entries(seen)) { const keys = Object.keys(ds); if (keys.length === 1) { const [x, y] = keys[0].split(',').map(Number); out[k] = { x, y }; } }
  return out;
}

module.exports.logicMismatches = logicMismatches;
module.exports.observedPortals = observedPortals;
