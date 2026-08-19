import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Layer = "delivery" | "application" | "domain" | "infrastructure";

interface Violation {
  from: string;
  to: string;
}

interface Baseline {
  violations: Violation[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "src");
const BASELINE_PATH = resolve(
  REPOSITORY_ROOT,
  "docs/architecture/dependency-rule-baseline.json",
);

const ALLOWED_IMPORTS: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  delivery: new Set(["delivery", "application", "domain"]),
  application: new Set(["application", "domain"]),
  domain: new Set(["domain"]),
  infrastructure: new Set(["infrastructure", "application", "domain"]),
};

const FORBIDDEN_DOMAIN_MODULES = new Set([
  "node:child_process",
  "node:cluster",
  "node:fs",
  "node:fs/promises",
  "node:worker_threads",
  "node-pty",
]);

function forbiddenDomainModule(specifier: string): string | undefined {
  const canonical = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  if (FORBIDDEN_DOMAIN_MODULES.has(canonical)) return canonical;
  return FORBIDDEN_DOMAIN_MODULES.has(specifier) ? specifier : undefined;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

function sourcePath(path: string): string {
  return `src/${relative(SOURCE_ROOT, path).split(sep).join("/")}`;
}

function layerFor(path: string): Layer {
  const relativePath = relative(SOURCE_ROOT, path).split(sep).join("/");
  const topLevel = relativePath.split("/", 1)[0];

  if (["mcp", "app-server", "client", "protocol"].includes(topLevel ?? "")) {
    return "delivery";
  }
  if (["orchestration", "control-plane", "broker"].includes(topLevel ?? "")) {
    return "application";
  }
  if (topLevel === "domain") return "domain";
  if (["runtime", "tmux", "providers", "persistence", "nvim"].includes(topLevel ?? "")) {
    return "infrastructure";
  }

  switch (relativePath) {
    case "cli.ts":
      return "delivery";
    case "config.ts":
    case "limits.ts":
      return "application";
    case "paths.ts":
    case "runtime-config.ts":
    case "version.ts":
      return "infrastructure";
    default:
      throw new Error(`No dependency layer assigned to ${sourcePath(path)}`);
  }
}

function withoutCommentsAndTemplates(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "regex" | "line" | "block" = "code";
  let regexCharacterClass = false;
  const templateExpressionDepths: number[] = [];

  function canStartRegexLiteral(index: number): boolean {
    const prefix = source.slice(0, index);
    const previousToken = prefix.match(/(?:^|\s)([A-Za-z_$][\w$]*)\s*$/)?.[1];
    if (
      previousToken
      && [
        "await",
        "case",
        "delete",
        "do",
        "else",
        "in",
        "instanceof",
        "of",
        "return",
        "throw",
        "typeof",
        "void",
        "yield",
      ].includes(previousToken)
    ) {
      return true;
    }

    const previousCharacter = prefix.match(/\S\s*$/)?.[0].trim();
    return previousCharacter === undefined || "([{:;,=!?&|+-*%^~<>".includes(previousCharacter);
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];

    if (state === "line") {
      if (character === "\n") {
        result += character;
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "template") {
      if (character === "\\" && next !== undefined) {
        result += next === "\n" ? " \n" : "  ";
        index += 1;
      } else if (character === "$" && next === "{") {
        result += "  ";
        index += 1;
        templateExpressionDepths.push(0);
        state = "code";
      } else if (character === "`") {
        result += " ";
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "regex") {
      if (character === "\\" && next !== undefined) {
        result += next === "\n" ? " \n" : "  ";
        index += 1;
      } else if (character === "[") {
        result += " ";
        regexCharacterClass = true;
      } else if (character === "]") {
        result += " ";
        regexCharacterClass = false;
      } else if (character === "/" && !regexCharacterClass) {
        result += " ";
        while (/[A-Za-z]/.test(source[index + 1] ?? "")) {
          result += " ";
          index += 1;
        }
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
        if (character === "\n") state = "code";
      }
      continue;
    }

    if (state === "single" || state === "double") {
      result += character;
      if (character === "\\" && next !== undefined) {
        result += next;
        index += 1;
      } else if (
        (state === "single" && character === "'")
        || (state === "double" && character === "\"")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else if (character === "'") {
      result += character;
      state = "single";
    } else if (character === "\"") {
      result += character;
      state = "double";
    } else if (character === "`") {
      result += " ";
      state = "template";
    } else if (character === "{" && templateExpressionDepths.length > 0) {
      result += character;
      const expressionIndex = templateExpressionDepths.length - 1;
      templateExpressionDepths[expressionIndex] = templateExpressionDepths[expressionIndex]! + 1;
    } else if (character === "}" && templateExpressionDepths.length > 0) {
      const expressionIndex = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[expressionIndex] === 0) {
        result += " ";
        templateExpressionDepths.pop();
        state = "template";
      } else {
        result += character;
        templateExpressionDepths[expressionIndex] = templateExpressionDepths[expressionIndex]! - 1;
      }
    } else if (character === "/" && canStartRegexLiteral(index)) {
      result += " ";
      regexCharacterClass = false;
      state = "regex";
    } else {
      result += character;
    }
  }

  return result;
}

function decodeModuleSpecifier(specifier: string): string | undefined {
  const simpleEscapes: Readonly<Record<string, string>> = {
    "'": "'",
    "\"": "\"",
    "\\": "\\",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  let decoded = "";

  for (let index = 0; index < specifier.length; index += 1) {
    const character = specifier[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escaped = specifier[index + 1];
    if (escaped === undefined) return undefined;
    index += 1;

    const simpleEscape = simpleEscapes[escaped];
    if (simpleEscape !== undefined) {
      decoded += simpleEscape;
    } else if (escaped === "0" && !/[0-9]/.test(specifier[index + 1] ?? "")) {
      decoded += "\0";
    } else if (escaped === "x") {
      const digits = specifier.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(digits)) return undefined;
      decoded += String.fromCharCode(Number.parseInt(digits, 16));
      index += 2;
    } else if (escaped === "u" && specifier[index + 1] === "{") {
      const closingBrace = specifier.indexOf("}", index + 2);
      if (closingBrace === -1) return undefined;
      const digits = specifier.slice(index + 2, closingBrace);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) return undefined;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) return undefined;
      decoded += String.fromCodePoint(codePoint);
      index = closingBrace;
    } else if (escaped === "u") {
      const digits = specifier.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return undefined;
      decoded += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
    } else if (escaped === "\n") {
      continue;
    } else if (escaped === "\r") {
      if (specifier[index + 1] === "\n") index += 1;
    } else {
      decoded += escaped;
    }
  }

  return decoded;
}

function dynamicModuleSpecifiersFromSource(source: string): string[] {
  const specifiers: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote === "'" || quote === "\"") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      continue;
    }

    if (
      !source.startsWith("import", index)
      || /[\w$.]/.test(source[index - 1] ?? "")
      || /[\w$]/.test(source[index + "import".length] ?? "")
    ) {
      continue;
    }

    let cursor = index + "import".length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "(") continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;

    const specifierQuote = source[cursor];
    if (specifierQuote !== "'" && specifierQuote !== "\"") continue;
    const specifierStart = cursor + 1;
    cursor = specifierStart;
    while (cursor < source.length && source[cursor] !== specifierQuote) {
      if (source[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    if (source[cursor] !== specifierQuote) continue;

    const specifier = decodeModuleSpecifier(source.slice(specifierStart, cursor));
    if (specifier === undefined) continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === ")" || source[cursor] === ",") specifiers.push(specifier);
  }

  return specifiers;
}

function staticModuleSpecifiersFromSource(unprocessedSource: string): string[] {
  const source = withoutCommentsAndTemplates(unprocessedSource);
  const patterns = [
    /^[ \t]*import\s*["']([^"'\r\n]+)["']/gm,
    /^[ \t]*import\s+(?:type\s+)?[^;]*?\s+from\s*["']([^"'\r\n]+)["']/gm,
    /^[ \t]*import\s+[^;]*?=\s*require\s*\(\s*["']([^"'\r\n]+)["']/gm,
    /^[ \t]*export\s+(?:type\s+)?(?:\*|\{)[^;]*?\s+from\s*["']([^"'\r\n]+)["']/gm,
  ];

  return [
    ...patterns.flatMap((pattern) => [...source.matchAll(pattern)]
      .map((match) => decodeModuleSpecifier(match[1]!))
      .filter((specifier): specifier is string => specifier !== undefined)),
    ...dynamicModuleSpecifiersFromSource(source),
  ];
}

function staticModuleSpecifiers(path: string): string[] {
  return staticModuleSpecifiersFromSource(readFileSync(path, "utf8"));
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const unresolved = resolve(dirname(importer), specifier);
  const extension = extname(unresolved);
  const candidates = [
    unresolved,
    extension ? `${unresolved.slice(0, -extension.length)}.ts` : `${unresolved}.ts`,
    resolve(unresolved, "index.ts"),
  ];
  const target = candidates.find((candidate) => existsSync(candidate));

  if (!target) {
    if (unresolved === SOURCE_ROOT || unresolved.startsWith(`${SOURCE_ROOT}${sep}`)) {
      throw new Error(`Cannot resolve ${specifier} imported by ${sourcePath(importer)}`);
    }
    return undefined;
  }

  if (target !== SOURCE_ROOT && !target.startsWith(`${SOURCE_ROOT}${sep}`)) return undefined;
  return target;
}

function compareViolations(left: Violation, right: Violation): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function violationKey(violation: Violation): string {
  return `${violation.from} imports ${violation.to}`;
}

function currentViolations(): Violation[] {
  const violations = new Map<string, Violation>();

  for (const importer of sourceFiles(SOURCE_ROOT)) {
    const importerLayer = layerFor(importer);

    for (const specifier of staticModuleSpecifiers(importer)) {
      const forbidden = importerLayer === "domain"
        ? forbiddenDomainModule(specifier)
        : undefined;
      if (forbidden !== undefined) {
        const violation = { from: sourcePath(importer), to: forbidden };
        violations.set(violationKey(violation), violation);
        continue;
      }

      const target = resolveSourceImport(importer, specifier);
      if (!target || ALLOWED_IMPORTS[importerLayer].has(layerFor(target))) continue;

      const violation = { from: sourcePath(importer), to: sourcePath(target) };
      violations.set(violationKey(violation), violation);
    }
  }

  return [...violations.values()].sort(compareViolations);
}

function baseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

describe("architecture dependency rule", () => {
  it("parses multiline declarations while ignoring comments and template text", () => {
    const source = `
      // import "./commented.js";
      import {
        first,
        second,
      } from "./multiline.js";
      /* export { hidden } from "./block-commented.js"; */
      export {
        visible,
      } from "./exported.js";
      const example = \`import "./template-text.js"\`;
      const stringExample = 'import("./string-text.js")';
      const marker = /[/*]/;
      await import("./dynamic.js");
      await import('../dynamic-single.js');
      await import(variableSpecifier);
      import "./side-effect.js";
    `;

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "./side-effect.js",
      "./multiline.js",
      "./exported.js",
      "./dynamic.js",
      "../dynamic-single.js",
    ]);
  });

  it("finds dynamic imports in template substitutions and with import options", () => {
    const source = `
      const rendered = \`literal \${await import("./template-substitution.js")}\`;
      await import("./with-options.js", { with: { type: "json" } });
    `;

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "./template-substitution.js",
      "./with-options.js",
    ]);
  });

  it("decodes escaped static and dynamic module specifiers", () => {
    const source = String.raw`
      import "node:f\x73";
      export * from "\x2e\x2e/runtime/exported.js";
      await import("node:f\u0073");
      await import('\x2e\x2e/runtime/dynamic.js');
    `;

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "node:fs",
      "../runtime/exported.js",
      "node:fs",
      "../runtime/dynamic.js",
    ]);
  });

  it("rejects bare aliases for forbidden Node built-ins", () => {
    const regressionFile = resolve(
      SOURCE_ROOT,
      "domain/dependency-rule-bare-builtins-regression.ts",
    );
    writeFileSync(regressionFile, [
      'import "fs";',
      'import "fs/promises";',
      'import "child_process";',
      'import "cluster";',
      'import "worker_threads";',
    ].join("\n"));

    try {
      expect(
        currentViolations().filter((violation) => violation.from === sourcePath(regressionFile)),
      ).toEqual([
        { from: sourcePath(regressionFile), to: "node:child_process" },
        { from: sourcePath(regressionFile), to: "node:cluster" },
        { from: sourcePath(regressionFile), to: "node:fs" },
        { from: sourcePath(regressionFile), to: "node:fs/promises" },
        { from: sourcePath(regressionFile), to: "node:worker_threads" },
      ]);
    } finally {
      rmSync(regressionFile, { force: true });
    }
  });

  it("keeps baseline sorted and unique", () => {
    const entries = baseline().violations;
    const sortedUnique = [...new Map(entries.map((entry) => [violationKey(entry), entry])).values()]
      .sort(compareViolations);

    expect(entries).toEqual(sortedUnique);
  });

  it("rejects new violations and stale baseline entries", () => {
    expect(currentViolations()).toEqual(baseline().violations);
  });
});
