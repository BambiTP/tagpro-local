# Real pops where the flag carrier hit a boost/bomb shortly before being tagged: what did the tagger get?
import json, glob, math, os
def U(p):
    d = p[2]; return d.get('u', d) if isinstance(d, dict) else d
out = []
for f in glob.glob(os.path.join(os.path.dirname(__file__), '../../ref/replay-archive/*.ndjson')):
    try: P = [json.loads(l) for l in open(f) if l.strip()]
    except Exception: continue
    state = {}; events = []   # (t, x, y, kind)
    for p in P:
        T = p[0]
        if p[1] == 'mapupdate':
            for u in (p[2] if isinstance(p[2], list) else [p[2]]):
                if str(u['v']) in ('5.1', '14.1', '15.1'): events.append((T, u['x'] * 0.4, u['y'] * 0.4, 'boost'))
        if p[1] == 'bomb' and p[2].get('type') == 2: events.append((T, p[2]['x'] / 100, p[2]['y'] / 100, 'bomb'))
        if p[1] != 'p': continue
        ups = U(p)
        victim = next((u for u in ups if u.get('dead') is True and 'sessionId' not in u), None)
        tagger = next((u for u in ups if 's-tags' in u and 'lx' in u), None) if victim else None
        if victim and tagger and victim['id'] in state and tagger['id'] in state:
            sv = state[victim['id']]; st = state[tagger['id']]
            v = {**sv, **victim}; t = {**st, **tagger}
            if all(k in v for k in ('rx', 'ry')) and all(k in st for k in ('lx', 'ly')) and 'rx' in t:
                # victim's last pre-pop sample close to a recent boost/bomb near the victim?
                ev = [e for e in events if 0 < T - e[0] < 400 and math.hypot(e[1] - v['rx'], e[2] - v['ry']) < 3.0]
                if ev and sv.get('_vt') and T - sv['_vt'] < 400:
                    d = math.hypot(t['rx'] - v['rx'], t['ry'] - v['ry']) or 1
                    nx, ny = (t['rx'] - v['rx']) / d, (t['ry'] - v['ry']) / d
                    dv = (t['lx'] - st['lx']) * nx + (t['ly'] - st['ly']) * ny
                    vin = sv['lx'] * nx + sv['ly'] * ny   # victim speed toward tagger (last known)
                    out.append((ev[-1][3], T - ev[-1][0], round(math.hypot(sv['lx'], sv['ly']), 2), round(vin, 2), round(-(st['lx'] * nx + st['ly'] * ny), 2), round(dv, 2), round(math.hypot(t['lx'], t['ly']), 2), T - sv['_vt']))
        for u in ups:
            s = state.setdefault(u['id'], {})
            s.update(u)
            if 'lx' in u: s['_vt'] = T
            if u.get('dead') is True: state[u['id']] = {}
print('kind  ms_since  FCspeed  FC->tagger  tagger->FC  tagger_dv  tagger_speed_after  FCsample_age')
for r in sorted(out, key=lambda r: -r[2]): print(*r)
