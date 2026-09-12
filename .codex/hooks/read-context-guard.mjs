import { readFileSync } from "node:fs";
import { runReadContextGuard } from "@seqlane/read-context/hook";

process.stdout.write(runReadContextGuard(readFileSync(0, "utf8")));
