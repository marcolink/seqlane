#!/usr/bin/env -S node --import @swc-node/register/esm-register --experimental-specifier-resolution=node --disable-warning=ExperimentalWarning

import { execute, settings } from "@oclif/core";

process.env.SEQLANE_CLI_DEVELOPMENT = "1";
settings.enableAutoTranspile = false;
await execute({ development: true, dir: import.meta.url });
