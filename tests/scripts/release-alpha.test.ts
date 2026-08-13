import { describe, expect, it } from "vitest";

import {
  assertNextAlphaVersion,
  assertPackFiles,
  localReleaseDate,
  nextAlphaVersion,
  updateReleaseDocuments,
} from "../../scripts/release-alpha.mjs";

const files = {
  "package.json": `${JSON.stringify({
    name: "@ishmael38/cyberdeck",
    version: "0.1.0-alpha.1",
  }, null, 2)}\n`,
  "README.md": "`0.1.0-alpha.1` is a macOS developer preview\n",
  ".github/ISSUE_TEMPLATE/bug_report.yml": "placeholder: 0.1.0-alpha.1\n",
  "CHANGELOG.md": [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Fast releases.",
    "",
    "## [0.1.0-alpha.1] - 2026-07-23",
    "",
    "[Unreleased]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.1...HEAD",
    "[0.1.0-alpha.1]: https://github.com/Brandon1138/cyberdeck/releases/tag/v0.1.0-alpha.1",
    "",
  ].join("\n"),
};

describe("alpha release automation", () => {
  it("increments only sequential alpha versions", () => {
    expect(nextAlphaVersion("0.1.0-alpha.1")).toBe("0.1.0-alpha.2");
    expect(() => nextAlphaVersion("0.1.0-beta.1")).toThrow("Expected an alpha version");
    expect(() => assertNextAlphaVersion("0.1.0-alpha.1", "0.1.0-alpha.3"))
      .toThrow("expected 0.1.0-alpha.2");
  });

  it("uses the operator's local calendar date", () => {
    expect(localReleaseDate(new Date(2026, 7, 14, 0, 5))).toBe("2026-08-14");
  });

  it("rolls Unreleased into the new version and updates every current-version surface", () => {
    const updated = updateReleaseDocuments(
      files,
      "0.1.0-alpha.1",
      "0.1.0-alpha.2",
      "2026-08-14",
    );
    expect(JSON.parse(updated["package.json"]!).version).toBe("0.1.0-alpha.2");
    expect(updated["README.md"]).toContain("`0.1.0-alpha.2` is a macOS developer preview");
    expect(updated[".github/ISSUE_TEMPLATE/bug_report.yml"])
      .toContain("placeholder: 0.1.0-alpha.2");
    expect(updated["CHANGELOG.md"]).toContain("## [Unreleased]\n\n## [0.1.0-alpha.2] - 2026-08-14");
    expect(updated["CHANGELOG.md"]).toContain(
      "[Unreleased]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.2...HEAD",
    );
    expect(updated["CHANGELOG.md"]).toContain(
      "[0.1.0-alpha.2]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.1...v0.1.0-alpha.2",
    );
  });

  it("requires the runnable CLI and rejects development-only package files", () => {
    const required = ["package.json", "LICENSE", "README.md", "dist/src/cli.js"];
    expect(() => assertPackFiles(required)).not.toThrow();
    expect(() => assertPackFiles(required.filter((path) => path !== "dist/src/cli.js")))
      .toThrow("missing dist/src/cli.js");
    expect(() => assertPackFiles([...required, "nvim.log"]))
      .toThrow("development-only file nvim.log");
  });
});
