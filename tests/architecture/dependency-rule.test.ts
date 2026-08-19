import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

function staticModuleSpecifiersFromSource(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "dependency-rule-source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sideEffectImports: string[] = [];
  const importsFrom: string[] = [];
  const importEquals: string[] = [];
  const exportsFrom: string[] = [];
  const dynamicImports: string[] = [];

  function stringLiteralText(node: ts.Node | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        (node.importClause === undefined ? sideEffectImports : importsFrom).push(specifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) importEquals.push(specifier);
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) exportsFrom.push(specifier);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== undefined) dynamicImports.push(specifier);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [
    ...sideEffectImports,
    ...importsFrom,
    ...importEquals,
    ...exportsFrom,
    ...dynamicImports,
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
