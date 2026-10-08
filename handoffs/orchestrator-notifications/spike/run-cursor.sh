#!/bin/bash
# usage: run-cursor.sh <runId> <workspace> <prompt> [extra agent args...]
S=/private/tmp/cyberdeck-hook-spike; cd $S
run=$1; ws=$2; prompt=$3; shift 3
CURSOR_CONFIG_DIR=$S/cursor-config CURSOR_DATA_DIR=$S/cursor-data timeout 240 agent -p --trust --approve-mcps \
  --workspace "$ws" --model composer-2.5 --output-format stream-json "$@" "$prompt" < /dev/null 2>&1 | node ts.mjs > "$run.out"
echo "exit=${PIPESTATUS[0]}"
node summarize-cursor.cjs "$run.out"
