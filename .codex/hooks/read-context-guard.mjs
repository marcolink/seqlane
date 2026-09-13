import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { runReadContextGuard } from "@seqlane/read-context/hook";

process.env.SEQLANE_READ_CONTEXT_ROOT ??= fileURLToPath(
  new URL("../..", import.meta.url),
);
process.stdout.write(runReadContextGuard(readFileSync(0, "utf8")));
