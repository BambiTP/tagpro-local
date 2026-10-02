# Measures pop boosts ("poosts") from real replays: tagger velocity change at the pop vs.
# approach speed, distance, and the victim's velocity. Only pops with a fresh pre-pop sample.
import json, glob, math, sys, os
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
rows = []
files = [f for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson'))]
for f in files:
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    state = {}    # id -> dict of latest values + time per field
    for p in P:
        if p[1] != 'p': continue
        T = p[0]; ups = U(p)
        victim = next((u for u in ups if u.get('dead') is True and 'sessionId' not in u and 'rx' in u), None)
        tagger = next((u for u in ups if 's-tags' in u and 'lx' in u and 'rx' in u), None) if victim else None
        if victim and tagger and victim['id'] in state and tagger['id'] in state:
            sv, st = state[victim['id']], state[tagger['id']]
            victim = {**sv, **victim}; tagger = {**st, **tagger}
            if all(k in st for k in ('lx','ly','rx','ry')) and all(k in sv for k in ('lx','ly','rx','ry')):
                age = T - min(st['_t'], sv['_t'])
                if age <= 70:
                    vx, vy = victim['rx'], victim['ry']            # victim position at pop
                    tx, ty = tagger['rx'], tagger['ry']
                    d = math.hypot(tx - vx, ty - vy)
                    if 0.2 < d < 0.6:
                        nx, ny = (tx - vx) / d, (ty - vy) / d      # outward normal (victim -> tagger)
                        dvx, dvy = tagger['lx'] - st['lx'], tagger['ly'] - st['ly']
                        radial = dvx * nx + dvy * ny
                        tang = -dvx * ny + dvy * nx
                        approach = -((st['lx'] - sv['lx']) * nx + (st['ly'] - sv['ly']) * ny)  # closing speed
                        t_in = -(st['lx'] * nx + st['ly'] * ny)   # tagger speed toward victim
                        v_out = sv['lx'] * nx + sv['ly'] * ny       # victim speed toward tagger? (negative = away)
                        rows.append(dict(age=age, d=d, radial=radial, tang=tang, approach=approach, t_in=t_in, v_in=-(sv['lx']*nx+sv['ly']*ny), tspeed=math.hypot(st['lx'], st['ly'])))
        for u in ups:
            s = state.setdefault(u['id'], {})
            for k, v in u.items(): s[k] = v
            if 'rx' in u or 'lx' in u: s['_t'] = T
            if u.get('dead') is True: state[u['id']] = {}
print('samples', len(rows))
import statistics as stt
def fit(xs, ys):
    mx, my = stt.mean(xs), stt.mean(ys)
    b = sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / sum((x-mx)**2 for x in xs)
    a = my - b*mx
    r = sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / math.sqrt(sum((x-mx)**2 for x in xs) * sum((y-my)**2 for y in ys))
    return a, b, r
R = [r['radial'] for r in rows]
print('radial dv: median %.3f  mean %.3f  sd %.3f' % (stt.median(R), stt.mean(R), stt.pstdev(R)))
print('tangential dv: median %.3f sd %.3f' % (stt.median([r['tang'] for r in rows]), stt.pstdev([r['tang'] for r in rows])))
for key in ('approach', 't_in', 'v_in', 'd', 'tspeed'):
    a, b, r = fit([x[key] for x in rows], R)
    print('radial = %.3f + %.3f * %-8s (r=%.2f)' % (a, b, key, r))
# two-variable: radial = a + b*t_in + c*v_in  (least squares)
import itertools
X = [(1, r['t_in'], r['v_in']) for r in rows]
def lstsq(X, y):
    n = len(X[0]); A = [[sum(x[i]*x[j] for x in X) for j in range(n)] for i in range(n)]; B = [sum(x[i]*yy for x, yy in zip(X, y)) for i in range(n)]
    for i in range(n):
        piv = A[i][i]
        for j in range(i, n): A[i][j] /= piv
        B[i] /= piv
        for k in range(n):
            if k != i:
                f = A[k][i]
                for j in range(i, n): A[k][j] -= f*A[i][j]
                B[k] -= f*B[i]
    return B
c = lstsq(X, R); print('radial = %.3f + %.3f*t_in + %.3f*v_in' % tuple(c))
res = [y - (c[0] + c[1]*x[1] + c[2]*x[2]) for x, y in zip(X, R)]; print('residual sd %.3f' % stt.pstdev(res))
if '-v' in sys.argv:
    for r in sorted(rows, key=lambda r: r['t_in'])[::max(1, len(rows)//25)]: print({k: round(v, 2) for k, v in r.items()})

# ---- model comparison ----
clean = [r for r in rows if r['age'] <= 70]
def sd(model):
    res = [r['radial'] - model(r) for r in clean]
    return stt.pstdev(res), stt.median([abs(x) for x in res])
best = None
for K in [x / 100 for x in range(130, 181, 2)]:
    for c in [x / 100 for x in range(0, 121, 5)]:
        for k in [x / 100 for x in range(40, 81, 2)]:
            s = sd(lambda r: max(K, k * max(r['approach'], 0) + c))
            if best is None or s[0] < best[0][0]: best = (s, K, c, k)
print('MAX model: radial = max(K=%.2f, %.2f*approach + %.2f)  sd=%.3f medAbs=%.3f' % (best[1], best[3], best[2], best[0][0], best[0][1]))
bestA = None
for K in [x / 100 for x in range(80, 181, 2)]:
    for k in [x / 100 for x in range(20, 81, 2)]:
        s = sd(lambda r: K + k * max(r['approach'], 0))
        if bestA is None or s[0] < bestA[0][0]: bestA = (s, K, k)
print('ADD model: radial = %.2f + %.2f*approach  sd=%.3f medAbs=%.3f' % (bestA[1], bestA[2], bestA[0][0], bestA[0][1]))
# smooth variant: sqrt(K^2 + (k*approach)^2)
bestS = None
for K in [x / 100 for x in range(130, 181, 2)]:
    for k in [x / 100 for x in range(40, 81, 2)]:
        s = sd(lambda r: math.sqrt(K * K + (k * max(r['approach'], 0)) ** 2))
        if bestS is None or s[0] < bestS[0][0]: bestS = (s, K, k)
print('HYPOT model: radial = hypot(%.2f, %.2f*approach)  sd=%.3f medAbs=%.3f' % (bestS[1], bestS[2], bestS[0][0], bestS[0][1]))
print('low-approach (<0.3) radial median %.3f (n=%d)' % (stt.median([r['radial'] for r in clean if abs(r['approach']) < 0.3]), len([r for r in clean if abs(r['approach']) < 0.3])))
print('negative approach (separating) radial median %.3f (n=%d)' % (stt.median([r['radial'] for r in clean if r['approach'] < -0.3] or [0]), len([r for r in clean if r['approach'] < -0.3])))
