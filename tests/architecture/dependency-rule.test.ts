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
  let state:
    | "code"
    | "single"
    | "double"
    | "template"
    | "static-template"
    | "regex"
    | "line"
    | "block" = "code";
  let regexCharacterClass = false;
  const templateExpressionDepths: number[] = [];
  const parenthesisContexts: Array<"expression" | "statement"> = [];
  const braceContexts: boolean[] = [];
  const regexAfterDelimiter = new Set<number>();

  function previousSignificantIndex(index: number): number | undefined {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (!/\s/.test(result[cursor]!)) return cursor;
    }
    return undefined;
  }

  function previousToken(index: number): string | undefined {
    let cursor = previousSignificantIndex(index);
    if (cursor === undefined || !/[\w$]/.test(result[cursor]!)) return undefined;
    const end = cursor + 1;
    while (cursor >= 0 && /[\w$]/.test(result[cursor]!)) cursor -= 1;
    const token = result.slice(cursor + 1, end);
    return /^[A-Za-z_$]/.test(token) ? token : undefined;
  }

  function closesFunctionExpression(index: number): boolean {
    const recentPrefix = result.slice(Math.max(0, index - 256), index);
    const header = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\([^{};]*\)\s*$/.exec(
      recentPrefix,
    );
    if (header === null) return false;

    let context = recentPrefix.slice(0, header.index).trimEnd();
    if (/\basync$/.test(context)) context = context.slice(0, -"async".length).trimEnd();
    if (header[1] === undefined) return !/\bexport\s+default$/.test(context);
    if (/\b(?:declare|export(?:\s+default)?)$/.test(context)) return false;

    const previousCharacter = context.at(-1);
    return previousCharacter !== undefined && !";{}".includes(previousCharacter);
  }

  function opensBlock(index: number): boolean {
    const previousIndex = previousSignificantIndex(index);
    const previousCharacter = previousIndex === undefined ? undefined : result[previousIndex];
    const token = previousToken(index);
    const recentPrefix = result.slice(Math.max(0, index - 256), index);

    return previousCharacter === undefined
      || previousCharacter === ";"
      || previousCharacter === "}"
      || (previousCharacter === ")" && !closesFunctionExpression(index))
      || /=>\s*$/.test(recentPrefix)
      || ["do", "else", "finally", "try"].includes(token ?? "")
      || /\b(?:class|enum|interface|module|namespace)\b[^{}]*$/.test(recentPrefix);
  }

  function startsStaticTemplateSpecifier(index: number): boolean {
    const recentPrefix = result.slice(Math.max(0, index - 128), index);
    return /(?:^|[^\w$.])import\s*\(\s*(?:\(\s*)*$/.test(recentPrefix);
  }

  function templateHasSubstitution(index: number): boolean {
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\\") cursor += 1;
      else if (source[cursor] === "$" && source[cursor + 1] === "{") return true;
      else if (source[cursor] === "`") return false;
    }
    return true;
  }

  function canStartRegexLiteral(index: number): boolean {
    const token = previousToken(index);
    if (
      token
      && [
        "await",
        "case",
        "default",
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
      ].includes(token)
    ) {
      return true;
    }

    const previousIndex = previousSignificantIndex(index);
    if (previousIndex !== undefined && regexAfterDelimiter.has(previousIndex)) return true;
    const previousCharacter = previousIndex === undefined ? undefined : result[previousIndex];
    if (
      previousIndex !== undefined
      && (previousCharacter === "+" || previousCharacter === "-")
    ) {
      const firstOperatorIndex = previousSignificantIndex(previousIndex);
      const operandIndex = firstOperatorIndex === undefined
        ? undefined
        : previousSignificantIndex(firstOperatorIndex);
      if (
        firstOperatorIndex === previousIndex - 1
        && result[firstOperatorIndex] === previousCharacter
        && operandIndex !== undefined
        && /[\w$)\]}]/.test(result[operandIndex]!)
      ) {
        return false;
      }
    }
    if (previousIndex !== undefined && previousCharacter === "!") {
      let operandIndex = previousSignificantIndex(previousIndex);
      while (operandIndex !== undefined && result[operandIndex] === "!") {
        operandIndex = previousSignificantIndex(operandIndex);
      }
      if (operandIndex !== undefined && /[\w$)\]}]/.test(result[operandIndex]!)) return false;
    }
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
        result += "0";
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "static-template") {
      result += character;
      if (character === "\\" && next !== undefined) {
        result += next;
        index += 1;
      } else if (character === "`") {
        state = "code";
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
      if (startsStaticTemplateSpecifier(index) && !templateHasSubstitution(index)) {
        result += character;
        state = "static-template";
      } else {
        result += " ";
        state = "template";
      }
    } else if (character === "(") {
      result += character;
      parenthesisContexts.push(
        ["catch", "for", "if", "switch", "while", "with"].includes(previousToken(index) ?? "")
          ? "statement"
          : "expression",
      );
    } else if (character === ")") {
      result += character;
      if (parenthesisContexts.pop() === "statement") regexAfterDelimiter.add(index);
    } else if (character === "{" && templateExpressionDepths.length > 0) {
      result += character;
      const expressionIndex = templateExpressionDepths.length - 1;
      templateExpressionDepths[expressionIndex] = templateExpressionDepths[expressionIndex]! + 1;
      braceContexts.push(opensBlock(index));
    } else if (character === "{") {
      result += character;
      braceContexts.push(opensBlock(index));
    } else if (character === "}" && templateExpressionDepths.length > 0) {
      const expressionIndex = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[expressionIndex] === 0) {
        result += " ";
        templateExpressionDepths.pop();
        state = "template";
      } else {
        result += character;
        templateExpressionDepths[expressionIndex] = templateExpressionDepths[expressionIndex]! - 1;
        if (braceContexts.pop() === true) regexAfterDelimiter.add(index);
      }
    } else if (character === "}") {
      result += character;
      if (braceContexts.pop() === true) regexAfterDelimiter.add(index);
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

function skipTypeScriptAssertion(source: string, start: number): number {
  const assertion = /^(?:as|satisfies)\b/.exec(source.slice(start));
  if (assertion === null) return start;

  let cursor = start + assertion[0].length;
  if (!/\s/.test(source[cursor] ?? "")) return start;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;

  const delimiters: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
  const expectedClosers: string[] = [];
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (character === "'" || character === "\"" || character === "`") {
      for (cursor += 1; cursor < source.length; cursor += 1) {
        if (source[cursor] === "\\") cursor += 1;
        else if (source[cursor] === character) break;
      }
      continue;
    }

    const closer = delimiters[character];
    if (closer !== undefined) {
      expectedClosers.push(closer);
    } else if (expectedClosers.at(-1) === character) {
      expectedClosers.pop();
    } else if (expectedClosers.length === 0 && (character === ")" || character === ",")) {
      return cursor;
    }
  }

  return start;
}

function skipTypeScriptPostfixAssertions(source: string, start: number): number {
  let cursor = start;
  while (source[cursor] === "!") {
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  return skipTypeScriptAssertion(source, cursor);
}

function dynamicModuleSpecifiersFromSource(source: string): string[] {
  const specifiers: string[] = [];

  scan: for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote === "'" || quote === "\"" || quote === "`") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      continue;
    }

    let previousIndex = index - 1;
    while (/\s/.test(source[previousIndex] ?? "")) previousIndex -= 1;

    if (
      !source.startsWith("import", index)
      || /[\w$]/.test(source[index - 1] ?? "")
      || (
        source[previousIndex] === "."
        && source.slice(Math.max(0, previousIndex - 2), previousIndex + 1) !== "..."
      )
      || /[\w$]/.test(source[index + "import".length] ?? "")
    ) {
      continue;
    }

    let cursor = index + "import".length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "(") continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let wrapperParentheses = 0;
    while (source[cursor] === "(") {
      wrapperParentheses += 1;
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    }

    const specifierQuote = source[cursor];
    if (specifierQuote !== "'" && specifierQuote !== "\"" && specifierQuote !== "`") continue;
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
    cursor = skipTypeScriptPostfixAssertions(source, cursor);
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    while (wrapperParentheses > 0) {
      if (source[cursor] !== ")") continue scan;
      wrapperParentheses -= 1;
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    }
    if (source[cursor] === ")" || source[cursor] === ",") specifiers.push(specifier);
  }

  return specifiers;
}

function quotedLiteralEnd(source: string, start: number): number | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== "\"") return undefined;

  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") cursor += 1;
    else if (source[cursor] === quote) return cursor;
    else if (source[cursor] === "\n" || source[cursor] === "\r") return undefined;
  }
  return undefined;
}

function quotedModuleSpecifierAt(source: string, start: number): string | undefined {
  const end = quotedLiteralEnd(source, start);
  return end === undefined
    ? undefined
    : decodeModuleSpecifier(source.slice(start + 1, end));
}

function moduleSpecifierAfterFrom(source: string, start: number): string | undefined {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const quoteEnd = quotedLiteralEnd(source, cursor);
    if (quoteEnd !== undefined) {
      cursor = quoteEnd;
      continue;
    }
    if (source[cursor] === ";") return undefined;
    if (
      source.startsWith("from", cursor)
      && !/[\w$]/.test(source[cursor - 1] ?? "")
      && !/[\w$]/.test(source[cursor + "from".length] ?? "")
    ) {
      cursor += "from".length;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      return quotedModuleSpecifierAt(source, cursor);
    }
  }
  return undefined;
}

function declarationModuleSpecifiersFromSource(source: string): {
  sideEffectImports: string[];
  importsFrom: string[];
  importEquals: string[];
  exportsFrom: string[];
} {
  const sideEffectImports: string[] = [];
  const importsFrom: string[] = [];
  const importEquals: string[] = [];
  const exportsFrom: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote === "'" || quote === "\"" || quote === "`") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      continue;
    }

    const previous = source[index - 1] ?? "";
    if (
      source.startsWith("import", index)
      && !/[\w$.]/.test(previous)
      && !/[\w$]/.test(source[index + "import".length] ?? "")
    ) {
      const candidate = source.slice(index);
      let cursor = index + "import".length;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const sideEffectSpecifier = quotedModuleSpecifierAt(source, cursor);
      if (sideEffectSpecifier !== undefined) {
        sideEffectImports.push(sideEffectSpecifier);
      } else {
        const fromSpecifier = moduleSpecifierAfterFrom(source, cursor);
        if (fromSpecifier !== undefined) {
          importsFrom.push(fromSpecifier);
        } else {
          const match = candidate.match(
            /^import\s+[^;]*?=\s*require\s*\(\s*(["'])((?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\r\n])*)\1/,
          );
          if (match !== null) {
            const specifier = decodeModuleSpecifier(match[2]!);
            if (specifier !== undefined) importEquals.push(specifier);
          }
        }
      }
    } else if (
      source.startsWith("export", index)
      && !/[\w$.]/.test(previous)
      && !/[\w$]/.test(source[index + "export".length] ?? "")
    ) {
      const candidate = source.slice(index);
      if (/^export\s+(?:type\s+)?(?:\*|\{)/.test(candidate)) {
        const specifier = moduleSpecifierAfterFrom(source, index + "export".length);
        if (specifier !== undefined) exportsFrom.push(specifier);
      }
    }
  }

  return { sideEffectImports, importsFrom, importEquals, exportsFrom };
}

function staticModuleSpecifiersFromSource(unprocessedSource: string): string[] {
  const source = withoutCommentsAndTemplates(unprocessedSource);
  const declarations = declarationModuleSpecifiersFromSource(source);

  return [
    ...declarations.sideEffectImports,
    ...declarations.importsFrom,
    ...declarations.importEquals,
    ...declarations.exportsFrom,
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
      await import(\`./template-specifier.js\`);
      await import(\`./template-\${variableSpecifier}.js\`);
      await import((("./parenthesized.js")));
      await import("./asserted.js" as string);
      await import("./non-null-asserted.js"!);
      const spread = { ... import("./spread.js") };
      const commentedSpread = { ... /* gap */ import("./commented-spread.js") };
      loader . import("./spaced-property.js");
      loader./* gap */import("./commented-property.js");
    `;

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "./template-substitution.js",
      "./with-options.js",
      "./template-specifier.js",
      "./parenthesized.js",
      "./asserted.js",
      "./non-null-asserted.js",
      "./spread.js",
      "./commented-spread.js",
    ]);
  });

  it("finds static declarations after other same-line module items", () => {
    const source = [
      'const marker = 1; import "../runtime/side-effect.js";',
      'const lookalike = \'; import "node:fs";\';',
      'import { "a;b" as named } from "../runtime/string-named.js";',
      'function marker() {} export { marker } from "../runtime/exported.js";',
    ].join("\n");

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "../runtime/side-effect.js",
      "../runtime/string-named.js",
      "../runtime/exported.js",
    ]);
  });

  it("accepts line continuations in static module specifiers", () => {
    const source = ['import "\\', '../runtime/continued.js";'].join("\n");

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "../runtime/continued.js",
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

  it("ignores regex literals after statement headers and blocks", () => {
    const source = `
      if (enabled) /import ("node:fs")/.test(text);
      if (enabled) {} /import ("node:child_process")/.test(text);
      export default /import ("node:worker_threads")/;
      interface Marker {} /import ("node:fs")/.test(text);
      enum Markers {} /import ("node:child_process")/.test(text);
      namespace MarkerSpace {} /import ("node:worker_threads")/.test(text);
      const quotient = (dividend) / import("./after-parenthesis.js") / divisor;
      const objectQuotient = {} / import("./after-object.js") / divisor;
      const postfixQuotient = value++ / (await import("./after-postfix.js")).value;
      const nonNullQuotient = value! / (await import("./after-non-null.js")).value;
      const templateQuotient = <any>\`2\` / (await import("./after-template.js")).value;
      const functionQuotient = <any>function () {} / (await import("./after-function.js")).value;
    `;

    expect(staticModuleSpecifiersFromSource(source)).toEqual([
      "./after-parenthesis.js",
      "./after-object.js",
      "./after-postfix.js",
      "./after-non-null.js",
      "./after-template.js",
      "./after-function.js",
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
