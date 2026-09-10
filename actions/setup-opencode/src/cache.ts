import { restoreCache, saveCache } from "@actions/cache";

export interface CachePort {
  restore(path: string, key: string): Promise<string | undefined>;
  save(path: string, key: string): Promise<number>;
}

export const actionsCache: CachePort = {
  restore: (path, key) => restoreCache([path], key),
  save: (path, key) => saveCache([path], key),
};

export async function tryRestore(
  cache: CachePort,
  path: string,
  key: string,
  onError: (error: unknown) => void,
): Promise<boolean> {
  try {
    const restoredKey = await cache.restore(path, key);
    return restoredKey === key;
  } catch (error) {
    onError(error);
    return false;
  }
}

export async function trySave(
  cache: CachePort,
  path: string,
  key: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await cache.save(path, key);
  } catch (error) {
    onError(error);
  }
}
