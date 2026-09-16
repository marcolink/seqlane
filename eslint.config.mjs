import nx from "@nx/eslint-plugin";

export const JsonDependencyCheckRuleOptions = {
  // The CLI resolves the runner package path without importing runtime code.
  ignoredDependencies: [
    "tslib",
    "vitest",
    "@seqlane/runtime",
    // The CLI resolves the pinned Community Studio entrypoint through createRequire.
    "mastra",
    // Vite copies Geist font assets from its package without importing code.
    "geist",
  ],
  ignoredFiles: [
    "{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}",
    "{projectRoot}/vite.config.{js,ts,mjs,mts}",
    "{projectRoot}/vitest.config.{js,ts,mjs,mts}",
    "{projectRoot}/src/**/*.{spec,test}.{ts,tsx}",
  ],
};

export default [
  {
    files: ["**/*.json"],
    rules: {
      "@nx/dependency-checks": ["error", JsonDependencyCheckRuleOptions],
    },
    languageOptions: {
      parser: await import("jsonc-eslint-parser"),
    },
  },
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    ignores: ["**/dist", "**/out-tsc", "**/vitest.config.*.timestamp*"],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: ["^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"],
          depConstraints: [
            {
              sourceTag: "npm:private",
              onlyDependOnLibsWithTags: ["type:lib", "scope:private"],
            },
            {
              sourceTag: "type:app",
              onlyDependOnLibsWithTags: ["type:lib"],
            },
            {
              sourceTag: "scope:private",
              onlyDependOnLibsWithTags: [
                "scope:private",
                "scope:internal",
                "scope:public",
              ],
            },
            {
              sourceTag: "scope:internal",
              onlyDependOnLibsWithTags: ["scope:internal", "scope:public"],
            },
            {
              sourceTag: "scope:public",
              onlyDependOnLibsWithTags: ["scope:public"],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.spec.ts", "**/*.spec.js"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
