# Speed of the booster over time after a boost pad (from all following updates).
import json, glob, math, os, statistics as stt
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
traces = {}
n = 0
for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson')):
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    pos = {}
    for i, p in enumerate(P):
        if p[1] == 'p':
            for u in U(p):
                s = pos.setdefault(u['id'], {}); s.update(u)
        if p[1] != 'mapupdate': continue
        for u in (p[2] if isinstance(p[2], list) else [p[2]]):
            if str(u['v']) not in ('5.1', '14.1', '15.1'): continue
            T = p[0]; bx, by = u['x'] * 0.4, u['y'] * 0.4
            who = None
            for q in P[i + 1:i + 8]:
                if q[0] - T > 20: break
                if q[1] == 'p':
                    for w in U(q):
                        s = {**pos.get(w['id'], {}), **w}
                        if 'rx' in s and 'ry' in s and 'lx' in w and math.hypot(s['rx'] - bx, s['ry'] - by) < 0.6: who = w['id']
            if who is None: continue
            n += 1
            cur = dict(pos.get(who, {}))
            for q in P[i + 1:i + 400]:
                dt = q[0] - T
                if dt > 450: break
                if q[1] != 'p': continue
                for w in U(q):
                    if w['id'] != who: continue
                    cur.update(w)
                    if 'lx' in w and 'lx' in cur and 'ly' in cur:
                        traces.setdefault(dt // 25 * 25, []).append(math.hypot(cur['lx'], cur['ly']))
print('boosts traced', n)
for k in sorted(traces):
    if len(traces[k]) >= 10: print('t+%3dms  n=%4d  speed median %.2f  p90 %.2f' % (k, len(traces[k]), stt.median(traces[k]), sorted(traces[k])[int(len(traces[k]) * 0.9)]))
