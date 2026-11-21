#!/bin/bash
# average duel win vs hard+expert, 40 each
for P in "$@"; do
  a=$(bun sim/duel.ts hard 40 "$P" &) ; b=$(bun sim/duel.ts expert 40 "$P")
  wait
  echo "$P | $a | $b"
done
