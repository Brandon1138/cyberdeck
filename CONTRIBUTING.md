# Contributing to Cyberdeck

Thanks for helping improve Cyberdeck. The project welcomes focused bug reports,
documentation corrections, tests, and implementation changes.

## Before opening a change

- Search existing issues first.
- For behavior changes or larger features, open an issue describing the user
  problem and proposed boundary before investing in implementation.
- Never include provider credentials, private transcripts, customer code, or
  model output containing sensitive data in an issue or pull request.

## Development setup

Cyberdeck currently supports macOS and pins Node.js 24.18.0 through mise.

```bash
git clone https://github.com/Brandon1138/cyberdeck.git
cd cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm install --frozen-lockfile
```

Run the complete deterministic gate before opening a pull request:

```bash
mise exec -- pnpm check
mise exec -- pnpm test
mise exec -- pnpm build
```

The automated suite uses fixtures and must not start a real provider, consume a
model call, alter provider authentication, or require network access. Live
provider checks must be explicitly requested and reported separately.

## Pull requests

Keep commits reviewable, describe user-visible behavior, add tests for changed
behavior, and update documentation when contracts or limitations change.

Contributions use the Developer Certificate of Origin. Add a `Signed-off-by`
line to every commit with `git commit --signoff` to certify that you have the
right to submit it under the project's Apache-2.0 license. See
<https://developercertificate.org/>.

All contributors must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
