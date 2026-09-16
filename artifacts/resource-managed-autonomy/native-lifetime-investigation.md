# Native lifetime investigation — 2026-09-16

Boundary: read-only installed macOS 27.0 / 26A5406e SDK and manual inspection against
source `68d425e34085418589c7f928d57376cb3f86c9e2`. No native workload, signing,
tracing, simulator or service mutation was performed. This is feasibility evidence,
not W9 acceptance.

No inspected supported unprivileged unsigned mechanism proved the entire descendant
and CoreSimulator service lifetime. The current executor therefore keeps cleanup
`unproven` and retains capacity. Process sampling remains measurement, not authority
to release a reservation or kill a process whose ownership was missed.

| Mechanism | Installed contract | Consequence |
| --- | --- | --- |
| launchd job | `/usr/share/man/man5/launchd.plist.5:609` cleans surviving processes only when they retain the same process group | `setsid`/group changes escape that lifetime boundary |
| kqueue process events | SDK `usr/include/sys/event.h:248,355`: NOTE_FORK lacks child PID; NOTE_TRACK/NOTE_CHILD unsupported since 10.5 | Cannot replace sampling with complete descendant discovery |
| Coalition exports | SDK `usr/lib/system/libsystem_kernel.tbd:143` exports coalition symbols but no corresponding inspected public declarations/man contract | Exported private symbols do not establish a supported ownership capability |
| EndpointSecurity | SDK `usr/include/EndpointSecurity/ESClient.h:799-827`: `es_new_descendants_client` covers recursive descendants without root/TCC, but requires `com.apple.developer.endpoint-security.client` | An entitled helper is a possible separate deployment requirement, not available proof from an unsigned helper; non-descendant services remain outside its scope |
| CoreSimulator | Installed CoreSimulatorService XPC Info.plist declares user service; `xpcservice.plist(5):28` has independent service lifetime | A dedicated simulator UUID is not evidence of dedicated host service ownership or termination |
| Custom sandbox | `sandbox-exec(1):18` is deprecated; SDK `sandbox.h:24,46` says custom sandbox initialization is no longer supported | Fork denial is experimental, and alone does not block launchd/XPC requests outside the descendant tree |

SDK root inspected: `/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk`.
EndpointSecurity event sequence gaps would also require explicit fail-closed handling
(`EndpointSecurity/ESMessage.h:2711`). No entitlement, account change or privileged
helper has been requested or installed.

The small simulator application can remain unsigned. A separately entitled supervision
helper would introduce an additional deployment prerequisite and still needs a supported
CoreSimulator ownership contract. This investigation does not establish that no design
exists; it records why the currently implemented polling/PGID approaches cannot satisfy
cleanup acceptance. Account-only Codex refresh has the same unresolved helper-lifetime
composition boundary; its uncomposed protocol leaf is not operational refresh.
