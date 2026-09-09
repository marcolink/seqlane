import { createRequire } from "node:module";

const nodeGlobal = globalThis as typeof globalThis & {
  require?: (moduleName: string) => unknown;
};

nodeGlobal.require ??= createRequire(import.meta.url);
