# Velocity change of players near a pop (excluding the tagger) vs distance from the popped ball.
import json, glob, math, os, statistics as stt
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
rows = []
for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson')):
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    state = {}
    for p in P:
        if p[1] != 'p': continue
        T = p[0]; ups = U(p)
        victim = next((u for u in ups if u.get('dead') is True and 'sessionId' not in u), None)
        if victim and victim['id'] in state and 'rx' in state[victim['id']]:
            v = {**state[victim['id']], **victim}
            tagger = next((u['id'] for u in ups if 's-tags' in u), None)
            for u in ups:
                if u['id'] in (victim['id'], tagger) or 'lx' not in u: continue
                s = state.get(u['id'], {})
                if not all(k in s for k in ('lx', 'ly', 'rx', 'ry')) or T - s['_t'] > 70: continue
                q = {**s, **u}
                d = math.hypot(q['rx'] - v['rx'], q['ry'] - v['ry'])
                if d < 1e-3: continue
                nx, ny = (q['rx'] - v['rx']) / d, (q['ry'] - v['ry']) / d
                dv = (q['lx'] - s['lx']) * nx + (q['ly'] - s['ly']) * ny
                tg = -(q['lx'] - s['lx']) * ny + (q['ly'] - s['ly']) * nx
                rows.append((d, dv, tg, T - s['_t']))
        for u in ups:
            s = state.setdefault(u['id'], {})
            s.update(u)
            if 'rx' in u or 'lx' in u: s['_t'] = T
            if u.get('dead') is True: state[u['id']] = {}
print('bystander samples', len(rows))
bins = {}
for d, dv, tg, age in rows: bins.setdefault(round(d * 5) / 5, []).append((dv, tg))
for b in sorted(bins):
    xs = bins[b]
    if len(xs) >= 3: print('d=%.1fm  n=%3d  radial dv median %.3f  tangential median %.3f' % (b, len(xs), stt.median([x[0] for x in xs]), stt.median([x[1] for x in xs])))
