#!/bin/bash
# Builds one scratch CODEX_HOME per Codex test (hooks.json is per-home). Auth is a symlink INTO scratch.
S=/private/tmp/cyberdeck-hook-spike; H="node $S/hook.mjs codex"
mk() { # <runId> <hooks-json-body>
  d=$S/codex-home-$1; mkdir -p $d; ln -sf /Users/brandon/.codex/auth.json $d/auth.json
  cp $S/codex-home/config.toml $d/config.toml
  printf '%s\n' "$2" > $d/hooks.json
}
mk x1 '{"hooks":{"PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"'"$H"' PostToolUse x1","timeout":5}]}]}}'
mk x2 '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'"$H"' Stop x2 --once","timeout":5}]}]}}'
mk x3 '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'"$H"' Stop x3 --shape block --once","timeout":5}]}]}}'
mk x4 '{"hooks":{"PostToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"'"$H"' PostToolUse x4 --exit 1 --stderr","timeout":5}]},{"matcher":"mcp__.*|^echo$","hooks":[{"type":"command","command":"'"$H"' PostToolUse x4 --sleep-ms 8000","timeout":2}]}]}}'
mk x5 '{"hooks":{"PostToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"'"$H"' PostToolUse x5 --exit 2 --stderr --print-nothing","timeout":5}]},{"matcher":"mcp__.*|^echo$","hooks":[{"type":"command","command":"'"$H"' PostToolUse x5 --print-nothing","timeout":5}]}]}}'
mk x6 '{"hooks":{"PostToolUse":[{"matcher":"","hooks":[{"type":"command","command":"'"$H"' PostToolUse x6","timeout":5}]}]}}'
for r in x1 x2 x3 x4 x5 x6; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' $S/codex-home-$r/hooks.json && echo "ok $r"; done
