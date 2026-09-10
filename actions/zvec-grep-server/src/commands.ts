const INDEX_ALLOWLIST = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.jsx",
  "*.json",
  "*.yaml",
  "*.yml",
  "*.md",
  "*.css",
  "*.html",
  "*.sh",
  ".github/**",
] as const;

const INDEX_EXCLUSIONS = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/.cache/**",
  "!**/.next/**",
  "!**/vendor/**",
  "!**/.env",
  "!**/.env.*",
  "!**/.envrc",
  "!**/.npmrc",
  "!**/id_*",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p8",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/*.crt",
  "!**/*.cer",
  "!**/*.der",
  "!**/*.csr",
  "!**/secrets/**",
  "!**/private/**",
  "!**/credentials/**",
  "!**/*secret*",
  "!**/*credential*",
  "!**/*token*",
  "!**/*service-account*",
  "!**/*service_account*",
  "!**/*auth*.json",
  "!**/*auth*.yaml",
  "!**/*auth*.yml",
] as const;

export const DEFAULT_INDEX_OPTIONS = {
  embedding: "local/potion-code-16m-v2",
  maxFilesize: "1M",
  additionalGlobs: [],
} as const;

export interface ZvecIndexOptions {
  readonly embedding: string;
  readonly maxFilesize: string;
  readonly additionalGlobs: readonly string[];
}

export type ZvecCommandPhase = "resolve" | "index" | "server" | "readiness";

export interface ZvecCommand {
  readonly phase: ZvecCommandPhase;
  readonly args: readonly string[];
}

export interface ZvecCommandPlanInput {
  readonly packageSpec: string;
  readonly projectDirectory: string;
  readonly listen: string;
  readonly home: string;
  readonly indexOptions?: Partial<ZvecIndexOptions>;
}

function globArguments(globs: readonly string[]): string[] {
  return globs.flatMap((glob) => ["--glob", glob]);
}

export function buildIndexArguments(
  packageSpec: string,
  projectDirectory: string,
  options: Partial<ZvecIndexOptions> = {},
): string[] {
  const indexOptions = {
    ...DEFAULT_INDEX_OPTIONS,
    ...options,
  };

  return [
    "dlx",
    packageSpec,
    "index",
    projectDirectory,
    "--mode",
    "direct",
    "--embedding",
    indexOptions.embedding,
    "--hidden",
    "--max-filesize",
    indexOptions.maxFilesize,
    ...globArguments(INDEX_ALLOWLIST),
    ...globArguments(indexOptions.additionalGlobs),
    ...globArguments(INDEX_EXCLUSIONS),
  ];
}

export function buildResolveArguments(packageSpec: string): string[] {
  return ["dlx", packageSpec, "version"];
}

export function buildServerArguments(
  packageSpec: string,
  listen: string,
): string[] {
  return ["dlx", packageSpec, "server", "run", "--listen", listen];
}

export function buildReadinessArguments(
  packageSpec: string,
  home: string,
): string[] {
  return [
    "dlx",
    packageSpec,
    "server",
    "status",
    "--check-ready",
    "--home",
    home,
  ];
}

export function buildZvecCommandPlan(
  input: ZvecCommandPlanInput,
): readonly [ZvecCommand, ZvecCommand, ZvecCommand, ZvecCommand] {
  return [
    {
      phase: "resolve",
      args: buildResolveArguments(input.packageSpec),
    },
    {
      phase: "index",
      args: buildIndexArguments(
        input.packageSpec,
        input.projectDirectory,
        input.indexOptions,
      ),
    },
    {
      phase: "server",
      args: buildServerArguments(input.packageSpec, input.listen),
    },
    {
      phase: "readiness",
      args: buildReadinessArguments(input.packageSpec, input.home),
    },
  ];
}

export function buildZvecEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  home: string,
  modelCache?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    ZVEC_GREP_HOME: home,
  };

  if (modelCache === undefined) {
    delete environment.ZVEC_GREP_MODEL_CACHE;
  } else {
    environment.ZVEC_GREP_MODEL_CACHE = modelCache;
  }

  return environment;
}
