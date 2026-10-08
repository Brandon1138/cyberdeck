#!/bin/bash
# usage: run-claude.sh <runId> <settings.json> <prompt> [extra claude args...]
cd /private/tmp/cyberdeck-hook-spike
run=$1; settings=$2; prompt=$3; shift 3
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p --setting-sources local --settings "$settings" \
  --mcp-config mcp.json --strict-mcp-config --allowedTools "Bash(echo spike)" "Bash(ls /nonexistent-spike)" "Bash(false)" "mcp__echo__echo" \
  --max-turns 4 --model haiku --no-session-persistence --output-format stream-json --verbose --include-hook-events \
  "$@" "$prompt" < /dev/null 2>&1 | node ts.mjs > "$run.out"
echo "exit=${PIPESTATUS[0]}"
node summarize-claude.cjs "$run.out"
