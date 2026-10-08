import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appStateDirectory,
  brokerConfigPath,
  brokerSocketPath,
  resolveAppPaths,
} from "../../src/broker/app-paths.js";
import * as compatibilityPaths from "../../src/paths.js";

describe("application paths", () => {
  it("preserves exact macOS defaults regardless of XDG overrides", () => {
    expect(resolveAppPaths({
      platform: "darwin",
      homeDirectory: "/Users/operator",
      environment: { XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/runtime", TMPDIR: "/temp" },
      uid: 501,
    })).toEqual({
      brokerSocketPath: "/tmp/cyberdeck-501.sock",
      appStateDirectory: "/Users/operator/Library/Application Support/Cyberdeck",
      brokerConfigPath: "/Users/operator/Library/Application Support/Cyberdeck/config.json",
    });
  });

  it("uses the default Linux XDG state directory without desktop or temporary paths", () => {
    expect(resolveAppPaths({
      platform: "linux",
      homeDirectory: "/home/operator",
      environment: { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/other/tmp" },
      uid: 1000,
    })).toEqual({
      brokerSocketPath: "/tmp/cyberdeck-1000.sock",
      appStateDirectory: "/home/operator/.local/state/cyberdeck",
      brokerConfigPath: "/home/operator/.local/state/cyberdeck/config.json",
    });
  });

  it.each([
    ["/private/state", "/private/state/cyberdeck"],
    ["/private/state/", "/private/state/cyberdeck"],
    ["/private/state with spaces", "/private/state with spaces/cyberdeck"],
    ["/", "/cyberdeck"],
    ["/private/state/../other", "/private/other/cyberdeck"],
  ])("honors absolute Linux XDG_STATE_HOME %s", (stateHome, expectedDirectory) => {
    const paths = resolveAppPaths({
      platform: "linux",
      homeDirectory: "/home/operator",
      environment: { XDG_STATE_HOME: stateHome },
      uid: 0,
    });
    expect(paths.appStateDirectory).toBe(expectedDirectory);
    expect(paths.brokerConfigPath).toBe(join(expectedDirectory, "config.json"));
    expect(paths.brokerSocketPath).toBe("/tmp/cyberdeck-0.sock");
  });

  it.each(["", "relative/state", "~/state", "../state", "C:\\state"])(
    "ignores empty or non-absolute Linux XDG_STATE_HOME %s",
    (stateHome) => {
      expect(resolveAppPaths({
        platform: "linux",
        homeDirectory: "/home/operator",
        environment: { XDG_STATE_HOME: stateHome },
      })).toEqual({
        brokerSocketPath: "/tmp/cyberdeck-user.sock",
        appStateDirectory: "/home/operator/.local/state/cyberdeck",
        brokerConfigPath: "/home/operator/.local/state/cyberdeck/config.json",
      });
    },
  );

  it("keeps exported paths and the compatibility barrel aligned with the current host", () => {
    const paths = resolveAppPaths({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: process.env,
      ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
    });
    expect({ brokerSocketPath, appStateDirectory, brokerConfigPath }).toEqual(paths);
    expect(compatibilityPaths).toMatchObject(paths);
  });
});
