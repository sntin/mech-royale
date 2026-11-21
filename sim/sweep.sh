#!/bin/bash
N=${N:-32}
for P in "$@"; do echo "$P => $(sim/batch.sh $N "$P" practice 1 | head -1)"; done
