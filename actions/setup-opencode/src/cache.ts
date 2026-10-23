import { restoreCache, saveCache } from "@actions/cache";
import { Effect } from "effect";

export interface CachePort {
  restore(path: string, key: string): Promise<string | undefined>;
  save(path: string, key: string): Promise<number>;
}

export const actionsCache: CachePort = {
  restore: (path, key) => restoreCache([path], key),
  save: (path, key) => saveCache([path], key),
};

export function tryRestore(
  cache: CachePort,
  path: string,
  key: string,
  onError: (error: unknown) => void,
): Effect.Effect<boolean, unknown> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => cache.restore(path, key),
      catch: (error) => error,
    }),
  ).pipe(
    Effect.map((restoredKey) => restoredKey === key),
    Effect.catch((error) =>
      Effect.sync(() => {
        onError(error);
        return false;
      }),
    ),
  );
}

export function trySave(
  cache: CachePort,
  path: string,
  key: string,
  onError: (error: unknown) => void,
): Effect.Effect<void, never> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => cache.save(path, key),
      catch: (error) => error,
    }),
  ).pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.sync(() => onError(error))),
  );
}
