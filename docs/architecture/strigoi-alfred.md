# Alfred resident instructions

Strigoi's reserved initial launch and succession launch append the operator's Alfred skill to the existing resident developer instructions. The content is loaded from:

```text
~/.local/share/strigoi/skills/alfred/SKILL.md
```

The home directory is the broker user's home, resolved with `os.homedir()`. This is an explicit resident-only path, independent of global provider skill discovery, project cwd, and Cyberdeck's state directory. Installing a skill here does not register it with workers or ordinary orchestrators. The skill is operator-managed and is not bundled into Cyberdeck releases.

The loader rereads the file for each newly launched resident incarnation, including renewal and recovery successors. Existing conversations keep their already assembled instructions. Reading a new file does not itself renew a session or submit a startup turn. Native resumption of an existing conversation is not a fresh skill-loading boundary.

The installed UTF-8 content is embedded unchanged between source and end markers so session instruction normalization cannot remove its trailing whitespace. It must be a nonempty regular file of at most 64 KiB. A missing, unreadable, invalid, or oversized file produces `STRIGOI_ALFRED_UNAVAILABLE` through the existing error-reporting callback and a diagnostic in the resident instructions. The original resident instructions and recovery pointers remain available; failure does not claim Alfred loaded or prevent ordinary residence.

Only the reserved resident launch paths call the loader. A worker or peer's display name, creator identity, or Fleet scope does not invoke it. Peers created by Strigoi receive the ordinary orchestrator instructions and existing grants, not the resident skill. The internal `alfredSkillPath` composition option allows isolated tests and embeddings to use a different file; it is not an RPC or worker request field.

Loading happens outside the binding authority transaction. Existing reservation, suspension, and admission checks still fence the subsequent launch. No recovery acknowledgement, grant, lease, notification policy, or scheduling state is changed by loading the skill.

The tests exercise the real session registry with fixture runtimes to check initial and renewal content, native Codex arguments, missing-file behavior, ordinary worker/Orc/peer isolation, and absence of additional inference submissions. These tests do not establish live provider acceptance or repair a pending recovery adoption.
