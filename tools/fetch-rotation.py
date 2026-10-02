# Downloads the real TagPro rotation (ref/maps.json from tagpro.koalabeast.com/maps.json) from
# Fortunate Maps. When a real replay contains the map, the FM version whose decoded tiles match
# the real server's "map" packet exactly is chosen; otherwise the newest upload by the same author.
# Writes maps/<fmId>.png/.json and maps/rotation.json (list of fm ids).
import json, glob, os, re, sys, time, urllib.parse, urllib.request, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = os.path.join(ROOT, 'maps')
FM = 'https://fortunatemaps.herokuapp.com'

def get(url, binary=False):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'tagpro-local'}), timeout=30) as r:
                data = r.read()
                return data if binary else data.decode('utf8', 'replace')
        except Exception as e:
            time.sleep(1 + attempt)
    return None

# real map packets from replays/captures, by map name
real = {}
for f in glob.glob(os.path.join(ROOT, 'ref/replay-archive/*.ndjson')) + glob.glob(os.path.join(ROOT, 'ref/replays/*.ndjson')) + glob.glob(os.path.join(ROOT, 'ref/live*/game*.ndjson')):
    try:
        with open(f) as fh:
            for line in fh:
                if '"map"' in line[:30]:
                    p = json.loads(line)
                    if p[1] == 'map': real.setdefault(p[2]['info']['name'], p[2]['tiles'])
                    break
    except Exception: pass

def decode(fm_id):
    # decode with the engine's own loader so the comparison matches what the server will send
    out = subprocess.run(['node', '-e', '''
const {PNG}=require("pngjs"),fs=require("fs"),{loadMap,trimPng}=require("./engine/mapLoader");
const m=loadMap(PNG.sync.read(trimPng(fs.readFileSync(process.argv[1]))),JSON.parse(fs.readFileSync(process.argv[2])));
process.stdout.write(JSON.stringify(m.tiles));''', f'/tmp/fm_{fm_id}.png', f'/tmp/fm_{fm_id}.json'], cwd=ROOT, capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 else None

def same(a, b):
    if len(a) != len(b) or len(a[0]) != len(b[0]): return False
    return all(str(a[x][y]) == str(b[x][y]) for x in range(len(a)) for y in range(len(a[0])))

rot = json.load(open(os.path.join(ROOT, 'ref/maps.json')))
wanted = [m for m in rot['rotation'].values() if not m.get('isDeleted')]
print(len(wanted), 'rotation maps;', len(real), 'have real map packets', flush=True)
chosen = {}
for m in wanted:
    name, author = m['name'], m.get('author', '')
    html = get(FM + '/search?q=' + urllib.parse.quote(name)) or ''
    ids = sorted({int(i) for i in re.findall(r'href="/map/(\d+)"', html)}, reverse=True)[:12]
    pick, how = None, ''
    for i in ids:
        j = get(f'{FM}/json/{i}')
        if not j: continue
        try: info = json.loads(j).get('info', {})
        except Exception: continue
        if info.get('name', '').strip().lower() != name.strip().lower(): continue
        png = get(f'{FM}/png/{i}', binary=True)
        if not png: continue
        open(f'/tmp/fm_{i}.json', 'w').write(j); open(f'/tmp/fm_{i}.png', 'wb').write(png)
        if name in real:
            t = decode(i)
            if t and same(t, real[name]): pick, how = i, 'exact match with real server'; break
        elif pick is None and author.split(' ')[0].lower() in (info.get('author') or '').lower():
            pick, how = i, 'newest by author (no real packet to verify)'
    if pick is None and ids and name not in real:
        how = 'NOT FOUND by author'
    if pick:
        os.replace(f'/tmp/fm_{pick}.png', os.path.join(MAPS, f'{pick}.png'))
        os.replace(f'/tmp/fm_{pick}.json', os.path.join(MAPS, f'{pick}.json'))
        chosen[name] = pick
    print(f'{name:28} -> {pick}  {how or "no exact match"}', flush=True)
    time.sleep(0.3)
json.dump([str(v) for v in chosen.values()], open(os.path.join(MAPS, 'rotation.json'), 'w'))
print('rotation maps installed:', len(chosen), '/', len(wanted))
