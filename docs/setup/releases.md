# Releasing Cyberdeck

Cyberdeck prereleases use one guarded local command and one tag-triggered GitHub
workflow. Run releases serially from a clean `main`; do not start the next alpha
until the command has verified the previous npm publication.

## Alpha release

Preview the next sequential version without changing anything:

```bash
mise exec -- pnpm run release:alpha -- --dry-run
```

Release it:

```bash
mise exec -- pnpm release:alpha
```

An explicit sequential version is also accepted:

```bash
mise exec -- pnpm release:alpha 0.1.0-alpha.3
```

The command fails closed unless local `main` exactly matches `origin/main`, the
checkout is clean, the current version exists on npm, and the target version and
tag do not. It then:

1. increments the alpha version in package metadata, README, issue template, and
   changelog;
2. runs the frozen install, typecheck, full tests, build, package inspection, and
   a clean install of the packed CLI;
3. commits and pushes `main`, waits for CI, creates and pushes the annotated tag;
4. waits for the tag-triggered npm publish workflow; and
5. verifies the live `next` dist-tag and a clean install from npm without moving
   `latest`.

If the command stops after pushing the release commit or tag, do not create the
next alpha and do not rewrite published history. Inspect the named CI/publish
run and the live npm registry, then repair or rerun that exact release manually.
The script deliberately refuses to guess after a partially completed release.
