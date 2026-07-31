import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface DirectoryCompletion {
  /** What the prompt should read after completing. Unchanged when nothing matched. */
  value: string;
  /** Directory names that matched the prefix, for the operator to disambiguate against. */
  candidates: readonly string[];
}

export interface DirectoryCompletionOptions {
  /** Where a relative draft is anchored. */
  cwd: string;
  home?: string | undefined;
  /** The directory-listing boundary, injected so completion is testable without a filesystem. */
  list?: ((directory: string) => Promise<readonly string[]>) | undefined;
}

/** Expand a leading `~` and anchor a relative path, without touching an already-absolute one. */
export function expandPath(draft: string, cwd: string, home = homedir()): string {
  const expanded = draft === "~"
    ? home
    : draft.startsWith("~/")
      ? join(home, draft.slice(2))
      : draft;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Complete a directory path one Tab at a time.
 *
 * A single match is taken and closed with a separator so the next Tab descends into it. Several
 * matches extend the draft only as far as they agree, which is what makes repeated Tab converge
 * rather than pick for the operator. Files are never offered: a project is a directory.
 */
export async function completeDirectoryPath(
  draft: string,
  options: DirectoryCompletionOptions,
): Promise<DirectoryCompletion> {
  const home = options.home ?? homedir();
  const list = options.list ?? defaultList;
  // A trailing separator means the operator has settled on that directory and wants its children.
  const listing = draft.endsWith("/");
  const absolute = expandPath(draft, options.cwd, home);
  const directory = listing ? absolute : dirname(absolute);
  const prefix = listing ? "" : basename(absolute);
  const entries = await list(directory).catch(() => []);
  const matches = entries.filter((entry) => entry.startsWith(prefix)).sort();
  if (matches.length === 0) return { value: draft, candidates: [] };
  const completed = matches.length === 1
    ? `${matches[0]!}/`
    : sharedPrefix(matches);
  // Rewriting only the last segment keeps whatever the operator typed — `~`, a relative
  // anchor — exactly as they typed it.
  const head = draft.slice(0, draft.length - prefix.length);
  return { value: `${head}${completed}`, candidates: matches };
}

function sharedPrefix(values: readonly string[]): string {
  const [first = "", ...rest] = values;
  let length = first.length;
  for (const value of rest) {
    while (length > 0 && !value.startsWith(first.slice(0, length))) length -= 1;
  }
  return first.slice(0, length);
}

async function defaultList(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}
