# summary.py <out.jsonl>...: totals over a batch run
import json,sys,collections
for f in sys.argv[1:]:
  R=[json.loads(l) for l in open(f) if l.strip()]
  ok=[r for r in R if 'error' not in r and r['segments']]
  seg=sum(r['segments'] for r in ok); ex=sum(r['exact'] for r in ok)
  co=sum(r['exact']+sum((r.get('consistent') or {}).values()) for r in ok)
  tags=collections.defaultdict(lambda:[0,0,0.0,0])
  for r in ok:
    for k,v in r['byTag'].items():
      for t in k.split('+'):
        tags[t][0]+=v['n'];tags[t][1]+=v['exact'];tags[t][2]+=v['sumErr'];tags[t][3]+=v['exact']+v.get('consistent',0)
  pr=sorted(r['pct'] for r in ok); pc=sorted(r.get('pctConsistent') or r['pct'] for r in ok)
  print(f"{f}: replays {len(R)} usable {len(ok)} segments {seg} exact {100*ex/max(1,seg):.2f}%  reproducible within rounding {100*co/max(1,seg):.2f}%  replays>=99.5% reproducible: {sum(p>=0.995 for p in pc)}  replays>=99%: {sum(p>=0.99 for p in pr)}  median replay {100*pr[len(pr)//2]:.1f}%  nologic {sum(not r['hasLogic'] for r in ok)}")
  for t,(n,e,s,c) in sorted(tags.items(),key=lambda x:-x[1][0]): print(f"   {t:10s} n={n:7d} exact={100*e/n:6.2f}% reproducible={100*c/n:6.2f}% avgerr={s/n:.4f}")
  print('   worst replays (reproducible %):',[(r['map'],round(100*(r.get('pctConsistent') or r['pct']),1)) for r in sorted(ok,key=lambda r:r.get('pctConsistent') or r['pct'])[:8]])
