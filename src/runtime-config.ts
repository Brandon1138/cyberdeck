import { readFileSync } from "node:fs";
import { BrokerRuntimeConfigSchema, type BrokerRuntimeConfig } from "./config.js";
import { brokerConfigPath } from "./paths.js";

/** Load the optional persistent broker config. Absence means schema defaults, never stale state. */
export function loadBrokerRuntimeConfig(path = brokerConfigPath): BrokerRuntimeConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return BrokerRuntimeConfigSchema.parse({});
    }
    throw error;
  }

  try {
    return BrokerRuntimeConfigSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`Invalid Cyberdeck broker config at ${path}`, { cause: error });
  }
}
