// Full broker composition, isolated by explicit socket and state paths. No provider starts.
import { join } from "node:path";
import { runBroker } from "../../../src/broker/main.js";
const root = process.argv[2]!;
await runBroker(join(root, "broker.sock"), root);
process.send?.({ ready: true });
