import { describe, expect, it } from "vitest";
import {
  buildProviderChildEnvironment,
  sessionLaunchEnvironment,
} from "../../src/providers/launch-environment.js";

const SOURCE: NodeJS.ProcessEnv = {
  PATH: "/source/bin::/fallback/bin",
  HOME: "/users/operator",
  USER: "operator",
  LOGNAME: "operator",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp/source/",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  LC_TIME: "ro_RO.UTF-8",
  LC_UNREVIEWED: "drop-this",
  TZ: "Europe/Bucharest",
  TERM: "source-terminal",
  COLORTERM: "truecolor",
  FORCE_COLOR: "1",
  XDG_CONFIG_HOME: "/xdg/config",
  XDG_CACHE_HOME: "/xdg/cache",
  XDG_STATE_HOME: "/xdg/state",
  SECURITYSESSIONID: "session-compatibility",
  CLAUDE_CONFIG_DIR: "/provider/claude",
  ANTHROPIC_BASE_URL: "https://claude-routing.invalid",
  CODEX_HOME: "/provider/codex",
  OPENAI_BASE_URL: "https://codex-routing.invalid",
  HTTPS_PROXY: "https://proxy.invalid",
  NO_PROXY: "localhost",
  NODE_EXTRA_CA_CERTS: "/trust/extra-ca.pem",
  PWD: "/source/pwd",
  OLDPWD: "/source/oldpwd",
  __MISE_SESSION: "mise-session",
  __MISE_DIFF: "mise-diff",
  __MISE_ORIG_PATH: "/mise/original",
  TMUX: "tmux-state",
  TMUX_PANE: "tmux-pane",
  SSH_AUTH_SOCK: "ambient-agent",
  HEADROOM_STATE: "headroom-state",
  ANTHROPIC_API_KEY: "drop-this",
  OPENAI_API_KEY: "drop-this",
  CLAUDE_PLUGIN_STATE: "drop-this",
  CODEX_TOKEN: "drop-this",
  PLUGIN_STATE: "plugin-state",
  UNRELATED_SENTINEL: "unrelated",
  CYBERDECK_PROCESS_ROLE: "spoofed",
  CYBERDECK_WORKER_MODE: "spoofed",
  DISABLE_UPDATES: "0",
  ENABLE_TOOL_SEARCH: "true",
};

describe("provider child environment", () => {
  it("builds a Claude PTY environment from exact reviewed layers", () => {
    const environment = buildProviderChildEnvironment({
      source: SOURCE,
      provider: "claude",
      cwd: "/workspace/claude",
      terminal: "pty",
      identity: { role: "orchestrator", workerMode: "caveman" },
      disableUpdates: true,
      enableToolSearch: true,
    });

    expect(environment).toMatchObject({
      PATH: SOURCE.PATH,
      HOME: SOURCE.HOME,
      LC_CTYPE: SOURCE.LC_CTYPE,
      LC_TIME: SOURCE.LC_TIME,
      PWD: "/workspace/claude",
      TERM: "xterm-256color",
      COLORTERM: SOURCE.COLORTERM,
      SECURITYSESSIONID: SOURCE.SECURITYSESSIONID,
      CLAUDE_CONFIG_DIR: SOURCE.CLAUDE_CONFIG_DIR,
      ANTHROPIC_BASE_URL: SOURCE.ANTHROPIC_BASE_URL,
      HTTPS_PROXY: SOURCE.HTTPS_PROXY,
      NODE_EXTRA_CA_CERTS: SOURCE.NODE_EXTRA_CA_CERTS,
      CYBERDECK_PROCESS_ROLE: "orchestrator",
      CYBERDECK_WORKER_MODE: "caveman",
      DISABLE_UPDATES: "1",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(environment.PATH).toBe(SOURCE.PATH);
    for (const key of [
      "OLDPWD",
      "__MISE_SESSION",
      "__MISE_DIFF",
      "__MISE_ORIG_PATH",
      "TMUX",
      "TMUX_PANE",
      "SSH_AUTH_SOCK",
      "HEADROOM_STATE",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_PLUGIN_STATE",
      "CODEX_TOKEN",
      "PLUGIN_STATE",
      "LC_UNREVIEWED",
      "UNRELATED_SENTINEL",
      "CODEX_HOME",
      "OPENAI_BASE_URL",
    ]) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it("keeps provider routing in its matching profile only", () => {
    const codex = buildProviderChildEnvironment({
      source: SOURCE,
      provider: "codex",
      cwd: "/workspace/codex",
      terminal: "pipe",
      identity: { role: "worker" },
    });
    const cursor = buildProviderChildEnvironment({
      source: SOURCE,
      provider: "cursor",
      cwd: "/workspace/cursor",
      terminal: "pipe",
      identity: { role: "worker" },
    });

    expect(codex).toMatchObject({
      CODEX_HOME: SOURCE.CODEX_HOME,
      OPENAI_BASE_URL: SOURCE.OPENAI_BASE_URL,
      TERM: SOURCE.TERM,
    });
    expect(codex.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(codex.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(cursor.CODEX_HOME).toBeUndefined();
    expect(cursor.OPENAI_BASE_URL).toBeUndefined();
    expect(cursor.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(cursor.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("denies SSH agent inheritance and makes explicit grants fresh and non-transitive", () => {
    const denied = buildProviderChildEnvironment({
      source: SOURCE,
      provider: "codex",
      cwd: "/workspace/denied",
      terminal: "pipe",
      identity: { role: "worker" },
    });
    expect(denied.SSH_AUTH_SOCK).toBeUndefined();

    const grantValue = ["synthetic", "operator", "grant"].join("-");
    const granted = buildProviderChildEnvironment({
      source: SOURCE,
      provider: "codex",
      cwd: "/workspace/granted",
      terminal: "pipe",
      identity: { role: "worker" },
      grant: { sshAuthSock: grantValue },
    });
    expect(granted.SSH_AUTH_SOCK).toBe(grantValue);

    const nextLaunch = sessionLaunchEnvironment(
      granted,
      "codex",
      "/workspace/next",
      { kind: "worker" },
    );
    expect(nextLaunch.SSH_AUTH_SOCK).toBeUndefined();
  });
});
