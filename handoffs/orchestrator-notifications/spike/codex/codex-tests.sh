#!/bin/bash
# ORCHESTRATOR: run on the host. Each run uses its own scratch CODEX_HOME; nothing under ~/.codex is written
# except Codex's own token refresh through the auth.json symlink.
# --dangerously-bypass-hook-trust is needed because hooks in an untrusted hooks.json are skipped silently;
# the hook sources are the scratch files built by make-codex-homes.sh.
S=/private/tmp/cyberdeck-hook-spike; cd $S
P1="Run the shell command \`echo spike\`, then call the MCP tool echo with text 'spike'. After each tool result, if you see any text matching CYBERDECK-SPIKE-NOTICE-*, reply with exactly that text on its own line, and quote verbatim any other hook or system message you saw. Then stop."
PS="Reply with the single word ready. If at any point you see text matching CYBERDECK-SPIKE-NOTICE-*, reply with exactly that text on its own line, then stop."
PF="Run the shell command \`false\`, then call the MCP tool echo with text 'fail'. After each tool result, if you see any text matching CYBERDECK-SPIKE-NOTICE-*, reply with exactly that text on its own line. Then stop."
run() { # <runId> <prompt>
  CODEX_HOME=$S/codex-home-$1 codex exec --skip-git-repo-check --ephemeral -C $S/codex-work --json \
    --dangerously-bypass-hook-trust "$2" < /dev/null 2>&1 | node ts.mjs > $1.out
  echo "=== $1 exit=${PIPESTATUS[0]}"; node summarize-codex.cjs $1.out
}
run x1 "$P1" & run x2 "$PS" & run x3 "$PS" & wait
run x4 "$P1" & run x5 "$P1" & run x6 "$PF" & wait
echo "=== hooks.log (codex)"; grep '"provider":"codex"' hooks.log
