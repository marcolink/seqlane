const MAX_OVERLAY_DEPTH = 128;

class NodeMapOverlay<K, V extends object> implements ReadonlyMap<K, V> {
  readonly #depth: number;
  readonly #size: number;

  constructor(
    readonly base: ReadonlyMap<K, V>,
    readonly changes: ReadonlyMap<K, V>,
  ) {
    this.#depth = base instanceof NodeMapOverlay ? base.#depth + 1 : 1;
    let additions = 0;
    for (const key of changes.keys()) {
      if (!base.has(key)) additions += 1;
    }
    this.#size = base.size + additions;
  }

  get depth(): number {
    return this.#depth;
  }

  get size(): number {
    return this.#size;
  }

  get(key: K): V | undefined {
    return this.changes.has(key) ? this.changes.get(key) : this.base.get(key);
  }

  has(key: K): boolean {
    return this.changes.has(key) || this.base.has(key);
  }

  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) {
      yield [key, this.changes.get(key) ?? value];
    }
    for (const [key, value] of this.changes) {
      if (!this.base.has(key)) yield [key, value];
    }
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

/** Apply a small immutable change set without copying every retained node. */
export function withMapChanges<K, V extends object>(
  source: ReadonlyMap<K, V>,
  changes: ReadonlyMap<K, V>,
): ReadonlyMap<K, V> {
  if (changes.size === 0) return source;
  if (source instanceof NodeMapOverlay && source.depth >= MAX_OVERLAY_DEPTH) {
    const overlays: NodeMapOverlay<K, V>[] = [];
    let base: ReadonlyMap<K, V> = source;
    while (base instanceof NodeMapOverlay) {
      overlays.push(base);
      base = base.base;
    }
    const compacted = new Map(base);
    for (let index = overlays.length - 1; index >= 0; index -= 1) {
      for (const [key, value] of overlays[index]?.changes ?? []) {
        compacted.set(key, value);
      }
    }
    for (const [key, value] of changes) compacted.set(key, value);
    return compacted;
  }
  return new NodeMapOverlay(source, changes);
}
