import type { Hook } from "@oclif/core";
import {
  findDottedInputFlagMissingValue,
  rewriteDottedInputFlags,
} from "../dotted-input-arguments.js";

const preparse: Hook.Preparse = async function ({ argv, options }) {
  if (options.context?.id !== "run") return argv;
  const missingValue = findDottedInputFlagMissingValue(argv);
  if (missingValue !== undefined) {
    this.error(`${missingValue} requires a value`);
    return argv;
  }
  return rewriteDottedInputFlags(argv);
};

export default preparse;
