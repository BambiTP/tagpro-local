# Velocity change of players vs distance from 'bomb' packet centres (type 1 rolling bomb, 2 bomb tile, 3 portal).
import json, glob, math, os, statistics as stt, sys
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
rows = {1: [], 2: [], 3: []}
for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson')):
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    state = {}; pending = []
    for p in P:
        T = p[0]
        if p[1] == 'bomb':
            pending.append((T, p[2])); continue
        if p[1] != 'p': continue
        ups = U(p)
        for (tb, b) in list(pending):
            if T - tb > 25: pending.remove((tb, b)); continue
            cx, cy = b['x'] / 100, b['y'] / 100
            for u in ups:
                if 'lx' not in u: continue
                s = state.get(u['id'], {})
                if not all(k in s for k in ('lx', 'ly', 'rx', 'ry')) or T - s['_t'] > 70: continue
                q = {**s, **u}
                d = math.hypot(q['rx'] - cx, q['ry'] - cy)
                if d < 1e-3: continue
                nx, ny = (q['rx'] - cx) / d, (q['ry'] - cy) / d
                dv = (q['lx'] - s['lx']) * nx + (q['ly'] - s['ly']) * ny
                rows.setdefault(b.get('type'), []).append((d, dv))
            pending.remove((tb, b))
        for u in ups:
            s = state.setdefault(u['id'], {})
            s.update(u)
            if 'rx' in u or 'lx' in u: s['_t'] = T
            if u.get('dead') is True: state[u['id']] = {}
for t, name in ((2, 'bomb tile'), (1, 'rolling bomb'), (3, 'portal')):
    xs = rows.get(t, [])
    print('== type %d %s: %d samples' % (t, name, len(xs)))
    bins = {}
    for d, dv in xs: bins.setdefault(round(d * 2.5) / 2.5, []).append(dv)
    for b in sorted(bins):
        if len(bins[b]) >= 3: print('  d=%.1fm n=%3d radial dv median %.3f' % (b, len(bins[b]), stt.median(bins[b])))

def fitlin(xs, rmax):
    pts = [(d, dv) for d, dv in xs if 0.3 < d < rmax]
    n = len(pts); mx = sum(d for d, _ in pts) / n; my = sum(v for _, v in pts) / n
    b = sum((d - mx) * (v - my) for d, v in pts) / sum((d - mx) ** 2 for d, _ in pts)
    a = my - b * mx
    res = stt.pstdev([v - (a + b * d) for d, v in pts])
    return -b, a / -b, n, res
for t, name, rmax in ((2, 'bomb tile', 2.6), (1, 'rolling bomb', 1.8), (3, 'portal', 1.5)):
    s, R, n, res = fitlin(rows[t], rmax)
    print('%-12s dv = %.3f * (%.3f - d)   [R=%.2f tiles, n=%d, resid sd %.2f]' % (name, s, R, R / 0.4, n, res))
