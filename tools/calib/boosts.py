# What does a boost pad do? Compare the booster's velocity right before vs. the update sent at the boost.
import json, glob, math, os, statistics as stt
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
rows = []
for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson')):
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    state = {}
    for i, p in enumerate(P):
        T = p[0]
        if p[1] == 'mapupdate':
            for u in (p[2] if isinstance(p[2], list) else [p[2]]):
                if str(u['v']) not in ('5.1', '14.1', '15.1'): continue
                bx, by = u['x'] * 0.4, u['y'] * 0.4
                # the booster's update arrives in a p packet at ~the same time
                for q in P[i + 1:i + 6]:
                    if q[0] - T > 20: break
                    if q[1] != 'p': continue
                    for w in U(q):
                        s = state.get(w['id'])
                        if not s or 'lx' not in w or not all(k in s for k in ('lx', 'ly', 'rx', 'ry')): continue
                        a = {**s, **w}
                        if math.hypot(a['rx'] - bx, a['ry'] - by) > 0.6 or q[0] - s['_t'] > 70: continue
                        keys = (('right' in s and s['right'] > 0) - ('left' in s and s['left'] > 0), ('down' in s and s['down'] > 0) - ('up' in s and s['up'] > 0))
                        rows.append(dict(vb=(s['lx'], s['ly']), va=(a['lx'], a['ly']), keys=keys, age=q[0] - s['_t']))
        if p[1] != 'p': continue
        for u in U(p):
            s = state.setdefault(u['id'], {})
            s.update(u)
            if 'lx' in u: s['_t'] = T
            if u.get('dead') is True: state[u['id']] = {}
print('boost samples', len(rows))
sp_b = [math.hypot(*r['vb']) for r in rows]; sp_a = [math.hypot(*r['va']) for r in rows]
dv = [math.hypot(r['va'][0] - r['vb'][0], r['va'][1] - r['vb'][1]) for r in rows]
print('speed before median %.2f, after median %.2f, |dv| median %.2f sd %.2f' % (stt.median(sp_b), stt.median(sp_a), stt.median(dv), stt.pstdev(dv)))
# is dv aligned with the pre-boost velocity direction?
al = []
for r in rows:
    b = math.hypot(*r['vb']); d = (r['va'][0] - r['vb'][0], r['va'][1] - r['vb'][1]); m = math.hypot(*d)
    if b > 0.5 and m > 0.5: al.append((r['vb'][0] * d[0] + r['vb'][1] * d[1]) / (b * m))
print('cos(dv, v_before) median %.3f  (1.0 = boost along current velocity)' % stt.median(al))
# key direction alignment
ak = []
for r in rows:
    k = r['keys']; km = math.hypot(*k); d = (r['va'][0] - r['vb'][0], r['va'][1] - r['vb'][1]); m = math.hypot(*d)
    if km and m > 0.5: ak.append((k[0] * d[0] + k[1] * d[1]) / (km * m))
print('cos(dv, keys) median %.3f' % (stt.median(ak) if ak else float('nan')))
bins = {}
for b, a, d in zip(sp_b, sp_a, dv): bins.setdefault(round(b), []).append((a, d))
for k in sorted(bins):
    if len(bins[k]) >= 5: print(' speed before ~%d m/s: n=%3d  after median %.2f  |dv| median %.2f' % (k, len(bins[k]), stt.median([x[0] for x in bins[k]]), stt.median([x[1] for x in bins[k]])))

# finer: after-speed distribution and dependence on along-velocity pre-speed
import collections
h = collections.Counter(round(a * 4) / 4 for a in sp_a)
print('after-speed histogram:', ' '.join('%.2f:%d' % (k, v) for k, v in sorted(h.items()) if v >= 15))
pts = [(b, a) for b, a in zip(sp_b, sp_a) if b < 7 and a > 4]
for lo in [x / 2 for x in range(0, 14)]:
    xs = [a for b, a in pts if lo <= b < lo + 0.5]
    if len(xs) >= 15: print(' before %.1f-%.1f: n=%4d after median %.2f  IQR %.2f-%.2f' % (lo, lo + 0.5, len(xs), stt.median(xs), sorted(xs)[len(xs) // 4], sorted(xs)[3 * len(xs) // 4]))

# direction dependence: does a diagonal boost go faster? compare models
def ang(v): b = math.hypot(*v); return (abs(v[0]) / b, abs(v[1]) / b) if b > 0.3 else None
M = []
for r in rows:
    a = ang(r['vb']); s = math.hypot(*r['va'])
    if a and s > 4: M.append((a, s, r))
bins = {}
for (c, sn), s, r in M: bins.setdefault(round(max(c, sn), 2) // 0.05 * 0.05, []).append(s)
print('max(|cos|,|sin|) of pre-boost direction vs after-speed:')
for k in sorted(bins):
    if len(bins[k]) >= 10: print('  %.2f  n=%4d after median %.2f   7.5/max=%.2f   7.5*(|c|+|s|)~' % (k, len(bins[k]), stt.median(bins[k]), 7.5 / max(k, 0.70)))
for name, f in (('square 7.5/max(|c|,|s|)', lambda c, s: 7.5 / max(c, s)), ('sum 7.5*(|c|+|s|)/...', lambda c, s: 7.5 * (c + s) / math.sqrt(2) * math.sqrt(2) / max(1, 1)), ('const 8.15', lambda c, s: 8.15)):
    res = [sp - f(c, s) for (c, s), sp, r in M]
    print('%-28s residual median %.3f  mad %.3f' % (name, stt.median(res), stt.median([abs(x) for x in res])))
