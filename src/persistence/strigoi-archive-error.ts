/** Invalid resident archive bytes/state, distinct from failed I/O or durability. */
export class StrigoiArchiveError extends Error {
  constructor(readonly code: "STRIGOI_CORRUPT_PINS" | "STRIGOI_MISSING_PIN_INDEX") {
    super(code); this.name = "StrigoiArchiveError";
  }
}
