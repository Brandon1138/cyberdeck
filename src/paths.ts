import { homedir } from "node:os";
import { join } from "node:path";

export const brokerSocketPath = `/tmp/cyberdeck-${process.getuid?.() ?? "user"}.sock`;
export const appStateDirectory = join(homedir(), "Library", "Application Support", "Cyberdeck");
