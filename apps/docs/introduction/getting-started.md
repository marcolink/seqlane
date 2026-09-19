# Getting started

Install Seqlane. Then run a workflow from your project.

Use Node.js 24 or later.

## Install globally

Install the CLI globally to use `seqlane` from any directory.

::: code-group

```sh [npm]
npm install --global seqlane
```

```sh [pnpm]
pnpm add --global seqlane
```

```sh [Yarn]
yarn global add seqlane
```

:::

## Install in a project

Install the CLI, workflow package, and schema package in the project that
owns the workflows.

::: code-group

```sh [npm]
npm install --save-dev seqlane
npm install @seqlane/core zod
```

```sh [pnpm]
pnpm add --save-dev seqlane
pnpm add @seqlane/core zod
```

```sh [Yarn]
yarn add --dev seqlane
yarn add @seqlane/core zod
```

:::

After a global installation, use `seqlane`. After a project installation, use
the matching package-manager command.

::: code-group

```sh [npm]
npx seqlane run <workflow> --input '{}'
```

```sh [pnpm]
pnpm exec seqlane run <workflow> --input '{}'
```

```sh [Yarn]
yarn seqlane run <workflow> --input '{}'
```

:::

Next, [run a workflow](/cli/run).
