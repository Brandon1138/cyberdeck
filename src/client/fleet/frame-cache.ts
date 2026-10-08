let current: Map<unknown, unknown> | undefined;
const VALUE = Symbol("prepared value");

/** Synchronous, frame-local memoization; no mutable snapshot or state survives into another frame. */
export function withFleetPreparation<T>(prepare: () => T): T {
  const previous = current;
  current = new Map();
  try { return prepare(); } finally { current = previous; }
}
export function prepared<T>(keys: readonly unknown[], compute: () => T): T {
  if (current === undefined) return compute();
  let values = current;
  for (const key of keys) {
    let child = values.get(key) as Map<unknown, unknown> | undefined;
    if (child === undefined) { child = new Map(); values.set(key, child); }
    values = child;
  }
  if (!values.has(VALUE)) values.set(VALUE, compute());
  return values.get(VALUE) as T;
}
