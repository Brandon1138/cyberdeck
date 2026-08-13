export function nextAlphaVersion(currentVersion: string): string;
export function assertNextAlphaVersion(currentVersion: string, targetVersion: string): void;
export function localReleaseDate(date?: Date): string;
export function updateReleaseDocuments(
  files: Record<string, string>,
  currentVersion: string,
  targetVersion: string,
  date: string,
): Record<string, string>;
export function assertPackFiles(paths: readonly string[]): void;
