const NORMALIZED_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RAW_NAME_LENGTH = 256;
const DEFAULT_MAXIMUM_NAMES = 128;

export interface BoundedNormalizedNameAllocator {
  readonly resolve: (name: string) => string;
}

/**
 * Creates a bounded, normalized name allocator for adapter-local telemetry.
 *
 * The allocator rejects raw input longer than 256 UTF-16 code units before
 * Unicode normalization, then applies NFKC and accepts only the bounded ASCII
 * name pattern. For example, full-width `ｅｃｈｏ` becomes `echo`; invalid,
 * oversized, or normalization-failing input uses the constant fallback. After
 * 128 distinct accepted names, further names also use the fallback and invoke
 * the overflow diagnostic at most once through the caller.
 */
export function createBoundedNormalizedNameAllocator(options: {
  readonly fallback: string;
  readonly maximumNames?: number;
  readonly onOverflow?: () => void;
}): BoundedNormalizedNameAllocator {
  const names = new Set<string>();
  const maximumNames = options.maximumNames ?? DEFAULT_MAXIMUM_NAMES;

  return {
    resolve(name) {
      if (name.length === 0 || name.length > MAX_RAW_NAME_LENGTH) {
        return options.fallback;
      }
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
