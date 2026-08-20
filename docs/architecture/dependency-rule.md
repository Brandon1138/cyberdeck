# Dependency rule

> **Status: ENFORCED.** This document defines the executable dependency rule and its authoritative layer assignments.

Cyberdeck uses an inward-only dependency rule. Domain code sits at the center. Application code may depend on domain code. Delivery and infrastructure are outer peers: each may depend on application and domain code, but neither may depend on the other. Code may always depend on code in its own layer.

```text
delivery        infrastructure
       \        /
        application
            |
          domain
```

Imports point down this diagram, never up or sideways between the two outer peers.

## Layer assignment

- **Composition:** exactly `src/broker/main.ts`, the construction-only composition root. It may import every layer to assemble concrete implementations; the sole importer is the executable bootstrap edge `src/cli.ts -> src/broker/main.ts`; startup retention is application-owned and `main.ts` only wires it.

- **Delivery:** `src/mcp/**`, `src/app-server/**`, `src/client/**`, `src/protocol/**`, and `src/cli.ts`. These are MCP, app-server, wire-protocol, CLI, and interactive client entry points.
- **Adapters/application:** `src/orchestration/**`, `src/control-plane/**`, `src/broker/**`, `src/config.ts`, and `src/limits.ts`. This conservatively keeps orchestration, control-plane, and broker code together as currently situated, along with application policy/configuration.
- **Domain:** `src/domain/**`. Domain code may not import delivery, application, or infrastructure code.
- **Infrastructure:** `src/runtime/**`, `src/tmux/**`, `src/providers/**`, `src/persistence/**`, `src/nvim/**`, `src/paths.ts`, `src/runtime-config.ts`, and `src/version.ts`. These contain runtime/process and PTY access, tmux, provider CLI adapters, filesystem/persistence implementations, nvim integration, and environment/runtime metadata.

Every `src/**/*.ts` file must match exactly one assignment. An unassigned future path fails enforcement until architecture owners place it deliberately.

## Allowed imports

- Composition may import composition, delivery, application, domain, or infrastructure. No source other than `src/cli.ts` may import composition, and `src/cli.ts` may import only `src/broker/main.ts` in that layer.

- Delivery may import delivery, adapters/application, or domain.
- Adapters/application may import adapters/application or domain.
- Domain may import domain only.
- Infrastructure may import infrastructure, adapters/application, or domain.
- Delivery and infrastructure may not import each other.

Domain also may not directly import process-spawning, PTY, tmux, provider-CLI, filesystem, or persistence machinery. Enforcement rejects domain imports of local infrastructure plus direct imports of `node:child_process`, `node:cluster`, `node:fs`, `node:fs/promises`, `node:worker_threads`, and `node-pty`.

## Enforcement and ratchet

`tests/architecture/dependency-rule.test.ts` walks `src/**/*.ts`, strips comments and template bodies with a quote-aware scanner, parses static `import` and `export ... from` declarations, resolves relative specifiers to source files, and compares prohibited edges with `dependency-rule-baseline.json`. The exact `src/broker/main.ts` path is the sole composition root.

Baseline records all violations present when this rule was introduced. Test fails when:

- a new prohibited edge appears;
- a baseline edge disappears but remains listed;
- baseline contains duplicates or is not sorted; or
- a source file has no layer assignment.

Removing an existing violation therefore requires removing its baseline entry in same change. Adding or preserving a new violation is not allowed.
