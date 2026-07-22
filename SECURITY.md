# Security policy

Cyberdeck launches locally installed, authenticated coding-agent CLIs and can
grant those processes access to working directories. Treat it as part of your
local development trust boundary.

## Supported versions

Cyberdeck is currently an alpha release. Security fixes are provided only for
the latest published version.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` prerelease | Yes |
| Older versions | No |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
**Report a vulnerability** form in the Security tab of
`Brandon1138/cyberdeck`. Include affected versions, reproduction steps, impact,
and any suggested mitigation. You should receive an acknowledgment within seven
days.

## Local security boundary

- Cyberdeck's broker accepts RPC over a local Unix socket. Any process running
  as the same operating-system user is inside the trusted local boundary.
- Provider processes inherit the launching user's environment because provider
  authentication and configuration commonly depend on it. Do not launch an
  untrusted provider executable or run Cyberdeck from an environment containing
  secrets that the selected provider must not receive.
- `read-only` and `workspace-write` are mapped to each provider's native safety
  controls. Cyberdeck does not replace the provider sandbox or the operating
  system's access controls.
- Cyberdeck does not implement telemetry or make direct outbound network
  requests. The provider CLIs it launches have their own network and telemetry
  behavior and their own terms.

## Local data

Cyberdeck stores session metadata, transcripts, preferences, job records, and
artifacts below:

```text
~/Library/Application Support/Cyberdeck/
```

Transcripts and artifacts may contain source code, prompts, tool output, file
paths, or other sensitive material. Back up, retain, and delete this directory
according to the sensitivity of the projects you operate. Package upgrades and
uninstallation do not remove it.

Provider credentials remain owned by the provider CLIs. Cyberdeck does not
copy credentials into its state directory.
