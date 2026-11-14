import { createHash } from "node:crypto";
import { z } from "zod";
import { StrigoiArtifactRefSchema, type StrigoiArtifactRef } from "../domain/strigoi.js";

const Child = z.object({ ref: StrigoiArtifactRefSchema, count: z.number().int().positive() }).strict();
const Node = z.union([
  z.object({ page: StrigoiArtifactRefSchema, offset: z.number().int().nonnegative() }).strict(),
  z.object({ left: Child, right: Child }).strict(),
]);
type IndexNode = z.infer<typeof Node>;
const digest = (node: IndexNode) => createHash("sha256").update(JSON.stringify(node)).digest("hex");
const invalid = () => new Error("STRIGOI_INVALID_CURSOR");

/** Packet-rooted Merkle proofs, not caller-selected pointers or process-local capabilities.
 * The cursor carries the small authenticated ancestor path. Advancing reads only the new
 * subtree: a complete walk reads each index node once, including after process restart. */
export class StrigoiPageIndex {
  constructor(private readonly put: (body: string) => Promise<StrigoiArtifactRef>,
    private readonly get: (ref: StrigoiArtifactRef) => Promise<string>) {}

  async write(pages: Array<{ page: StrigoiArtifactRef; offset: number }>): Promise<StrigoiArtifactRef> {
    const build = async (start: number, end: number): Promise<StrigoiArtifactRef> => {
      if (end - start === 1) return this.put(JSON.stringify(Node.parse(pages[start])));
      const middle = start + Math.floor((end - start) / 2);
      const left = { ref: await build(start, middle), count: middle - start };
      const right = { ref: await build(middle, end), count: end - middle };
      return this.put(JSON.stringify(Node.parse({ left, right })));
    };
    return build(0, pages.length);
  }

  async read(root: StrigoiArtifactRef, count: number, packetHash: string, cursor?: string) {
    let index = 0, path: IndexNode[];
    if (cursor === undefined) path = await this.descend(root);
    else {
      try {
        const token = z.object({ packetHash: z.literal(packetHash), index: z.number().int().nonnegative(), path: z.array(Node) }).strict()
          .parse(JSON.parse(Buffer.from(cursor.replace(/^v2:/, ""), "base64url").toString("utf8")));
        if (!cursor.startsWith("v2:") || token.index >= count || token.path.length > 1 + Math.ceil(Math.log2(count))) throw invalid();
        index = token.index; path = token.path;
      } catch { throw invalid(); }
    }
    // Reauthenticate every supplied ancestor against the immutable manifest root.
    let ref = root, remaining = count, ordinal = index;
    const directions: boolean[] = [];
    for (const [depth, node] of path.entries()) {
      if (digest(node) !== ref.sha256) throw invalid();
      if ("page" in node) {
        if (remaining !== 1 || ordinal !== 0 || depth !== path.length - 1) throw invalid();
      } else {
        if (node.left.count + node.right.count !== remaining) throw invalid();
        const right = ordinal >= node.left.count; directions.push(right);
        const child = right ? node.right : node.left;
        if (right) ordinal -= node.left.count;
        remaining = child.count; ref = child.ref;
      }
    }
    const leaf = path.at(-1);
    if (!leaf || !("page" in leaf)) throw invalid();
    let nextCursor: string | undefined;
    if (index + 1 < count) {
      let depth = directions.length - 1;
      while (depth >= 0 && directions[depth]) depth--;
      const parent = path[depth];
      if (!parent || !("right" in parent)) throw invalid();
      const nextPath = [...path.slice(0, depth + 1), ...await this.descend(parent.right.ref)];
      nextCursor = "v2:" + Buffer.from(JSON.stringify({ packetHash, index: index + 1, path: nextPath })).toString("base64url");
    }
    return { ref: leaf.page, offset: leaf.offset, last: index + 1 === count, nextCursor };
  }

  private async descend(ref: StrigoiArtifactRef): Promise<IndexNode[]> {
    const path: IndexNode[] = [], seen = new Set<string>();
    for (;;) {
      if (seen.has(ref.sha256)) throw new Error("STRIGOI_INVENTORY_CYCLE");
      seen.add(ref.sha256);
      const node = Node.parse(JSON.parse(await this.get(ref))); path.push(node);
      if ("page" in node) return path;
      ref = node.left.ref;
    }
  }
}
