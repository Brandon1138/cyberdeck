/** Pure renderer fixtures: no shared broker, provider processes, or tmux interaction. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createFleetState, renderFleet, type FleetState } from "../src/client/fleet.js";
import { hierarchyFixture, TREE_NOW } from "../tests/fixtures/fleet-hierarchy.js";
import { workerTreeKey } from "../src/client/fleet/session-tree.js";
import { displayWidth } from "../src/client/display-width.js";
const destination = resolve(process.argv[2] ?? ".local/fleet-hierarchy");
await mkdir(destination, { recursive: true });
const snapshot = hierarchyFixture();
const state = { ...createFleetState(snapshot), selectedSessionId: "Parking Orc" };
const variants: Array<[string, FleetState]> = [
  ["live", state],
  ["folded", { ...state, collapsedCwds: [workerTreeKey("Parking Orc")] }],
  ["workers", { ...state, listView: "workers", focusedViewControl: "workers" }],
  ["history", { ...state, listView: "history", focusedViewControl: "history" }],
];
const measurements = [];
for (const [width, height] of [[32, 18], [48, 45], [60, 45], [100, 45], [160, 55]]) {
  for (const [name, variant] of variants) {
    const text = renderFleet(snapshot, variant, { width: width!, height: height!, color: false, now: Date.parse(TREE_NOW), home: "/Users/operator" });
    const lines = text.split("\n");
    const maximumWidth = Math.max(...lines.map(displayWidth));
    if (maximumWidth > width! || lines.length > height!) throw new Error(`${name} exceeds ${width}x${height}`);
    const file = `${width}x${height}-${name}.txt`;
    await writeFile(join(destination, file), text + "\n");
    measurements.push({ file, width, height, maximumWidth, rows: lines.length });
  }
}
await writeFile(join(destination, "validation.json"), JSON.stringify(measurements, null, 2) + "\n");
process.stdout.write(`Validated ${measurements.length} renderer frames in ${destination}\n`);
