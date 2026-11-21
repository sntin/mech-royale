#!/bin/bash
# usage: sim/batch.sh N PARAMS [mode] [cheat]  -> prints mean score
N=${1:-16}; P=${2:-'{}'}; MODE=${3:-practice}; CH=${4:-1}; J=4
per=$(( (N + J - 1) / J ))
tmp=$(mktemp -d)
for j in $(seq 0 $((J-1))); do
  bun sim/run.ts $MODE $((1 + j*per)) $per "$P" $CH > $tmp/$j.out 2>$tmp/$j.err &
done
wait
cat $tmp/*.out | grep '^{' > $tmp/all
python3 - $tmp/all <<'P'
import json,sys,statistics as st
r=[json.loads(l) for l in open(sys.argv[1])]
sc=[x['score'] for x in r]
print(f"n={len(r)} mean={st.mean(sc):.2f} se={st.pstdev(sc)/len(sc)**.5:.2f} deathT={st.mean(x['deathT'] for x in r):.0f} kills={st.mean(x['kills'] for x in r):.2f} cubes={st.mean(x['cubes'] for x in r):.1f} taken={st.mean(x['taken'] for x in r):.0f} dealt={st.mean(x['dealt'] for x in r):.0f} houseDead={st.mean(x['houseDead'] for x in r):.1f}")
print(sorted(sc))
P
cat $tmp/*.err | head -5
