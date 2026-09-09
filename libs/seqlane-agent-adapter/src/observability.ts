const NORMALIZED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAXIMUM_NAMES = 128;

export interface BoundedNormalizedNameAllocator {
  readonly resolve: (name: string) => string;
}

/** Creates a bounded, normalized name allocator for adapter-local telemetry. */
export function createBoundedNormalizedNameAllocator(options: {
  readonly fallback: string;
  readonly maximumNames?: number;
  readonly onOverflow?: () => void;
}): BoundedNormalizedNameAllocator {
  const names = new Set<string>();
  const maximumNames = options.maximumNames ?? DEFAULT_MAXIMUM_NAMES;

  return {
    resolve(name) {
      let normalized: string;
      try {
        normalized = name.normalize("NFKC");
      } catch {
        normalized = "";
      }
      if (!NORMALIZED_NAME_PATTERN.test(normalized)) return options.fallback;
      if (names.has(normalized)) return normalized;
      if (names.size >= maximumNames) {
        options.onOverflow?.();
        return options.fallback;
      }
      names.add(normalized);
      return normalized;
    },
  };
}
