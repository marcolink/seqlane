// @test-scope ./prepare-release.mjs ./release-channel.mjs ./check-release-publication.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const nxConfig = JSON.parse(readFileSync(join(workspace, "nx.json"), "utf8"));

test(
  "real Nx versions, tags, packs, retries, and promotes an isolated beta release",
  { timeout: 180_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "seqlane-release-integration-"));
    const repo = join(root, "repository");
    const remote = join(root, "remote.git");
    const bin = join(root, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    symlinkSync(join(workspace, "node_modules"), join(repo, "node_modules"));
    const env = {
      ...process.env,
      NX_DAEMON: "false",
      NX_ISOLATE_PLUGINS: "false",
      NX_WORKSPACE_DATA_DIRECTORY: join(root, "nx-data"),
      NX_CACHE_DIRECTORY: join(root, "nx-cache"),
      SEQLANE_RELEASE_NX_ADAPTER: "",
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    };
    function run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        cwd: repo,
        env,
        encoding: "utf8",
        timeout: 60_000,
        ...options,
      });
      assert.equal(
        result.status,
        0,
        `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
      );
      return result.stdout.trim();
    }
    const git = (...args) => run("git", args);
    function commit(path, message, value) {
      writeFileSync(join(repo, path), value);
      git("add", path);
      git("commit", "-m", message);
      return git("rev-parse", "HEAD");
    }
    function release(branch, revision = git("rev-parse", "HEAD")) {
      const output = join(root, "result.json");
      run(
        process.execPath,
        [join(workspace, "scripts/prepare-release.mjs"), "--output", output],
        { env: { ...env, GITHUB_REF_NAME: branch, GITHUB_SHA: revision } },
      );
      return JSON.parse(readFileSync(output, "utf8"));
    }
    function clean() {
      git("restore", "packages");
      rmSync(join(repo, "CHANGELOG.md"), { force: true });
    }
    try {
      writeFileSync(
        join(bin, "gh"),
        '#!/bin/sh\nif [ "$2" = view ]; then exit 1; fi\n',
      );
      chmodSync(join(bin, "gh"), 0o755);
      writeFileSync(
        join(repo, "nx.json"),
        JSON.stringify({ release: nxConfig.release, analytics: false }),
      );
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          name: "fixture-workspace",
          private: true,
          packageManager: "pnpm@10.33.0",
          devDependencies: { nx: "22.7.1", "@nx/js": "22.7.1" },
        }),
      );
      writeFileSync(
        join(repo, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );
      writeFileSync(
        join(repo, ".gitignore"),
        "node_modules/\n.nx/\nCHANGELOG.md\n",
      );
      writeFileSync(
        join(repo, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\npackages: {}\nsnapshots: {}\nimporters:\n  .: {}\n  packages/core: {}\n  packages/cli:\n    dependencies:\n      '@seqlane/fixture-core':\n        specifier: workspace:*\n        version: link:../core\n",
      );
      for (const name of ["core", "cli"]) {
        const directory = join(repo, "packages", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "project.json"),
          JSON.stringify({ name, tags: ["release:npm"] }),
        );
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({
            name: `@seqlane/fixture-${name}`,
            version: "0.0.0",
            files: ["index.js"],
            dependencies:
              name === "cli" ? { "@seqlane/fixture-core": "workspace:*" } : {},
          }),
        );
        writeFileSync(
          join(directory, "index.js"),
          "export const value = true;\n",
        );
      }
      const scope = join(repo, "packages/cli/node_modules/@seqlane");
      mkdirSync(scope, { recursive: true });
      symlinkSync(join(repo, "packages/core"), join(scope, "fixture-core"));
      git("init", "--initial-branch=main");
      git("config", "user.name", "Release Test");
      git("config", "user.email", "release@example.com");
      git("add", ".");
      git("commit", "-m", "chore: baseline");
      git("tag", "v0.2.1");
      run("git", ["init", "--bare", remote]);
      git("remote", "add", "origin", remote);
      git("push", "origin", "main", "--tags");
      git("switch", "-c", "next");
      const firstSha = commit(
        "packages/cli/index.js",
        "feat: migrate runtime",
        "export const value = false;\n",
      );
      git("push", "-u", "origin", "next");
      assert.equal(release("next").releaseTag, "v0.3.0-beta.0");
      assert.match(
        readFileSync(join(repo, "packages/cli/package.json"), "utf8"),
        /workspace:\*/,
      );
      const archive = join(root, "cli.tgz");
      run("pnpm", ["--dir", "packages/cli", "pack", "--out", archive]);
      const manifest = JSON.parse(
        run("tar", ["-xOf", archive, "package/package.json"]),
      );
      assert.equal(manifest.version, "0.3.0-beta.0");
      assert.equal(
        manifest.dependencies["@seqlane/fixture-core"],
        "0.3.0-beta.0",
      );
      run("npm", [
        "publish",
        archive,
        "--dry-run",
        "--tag",
        "next",
        "--ignore-scripts",
        "--cache",
        join(root, "npm-cache"),
      ]);
      clean();
      commit(
        "packages/cli/index.js",
        "fix: improve migration",
        "export const value = 2;\n",
      );
      git("push", "origin", "next");
      assert.equal(release("next").releaseTag, "v0.3.0-beta.1");
      clean();
      commit("NOTES.md", "docs: notes only", "notes\n");
      git("push", "origin", "next");
      assert.equal(release("next").released, false);
      git("switch", "main");
      commit(
        "packages/core/index.js",
        "fix: stable hotfix",
        "export const value = 3;\n",
      );
      git("push", "origin", "main");
      assert.equal(release("main").releaseTag, "v0.2.2");
      clean();
      git(
        "merge",
        "next",
        "--no-ff",
        "-m",
        "feat(runtime): promote accepted beta",
      );
      git("push", "origin", "main");
      assert.equal(release("main").releaseTag, "v0.3.0");
      assert.match(
        readFileSync(join(repo, "CHANGELOG.md"), "utf8"),
        /migrate runtime/,
      );
      clean();
      git("tag", "v0.3.1", firstSha);
      git("push", "origin", "v0.3.1");
      assert.equal(release("next", firstSha).state, "recover");
      assert.equal(git("rev-parse", "v0.3.0-beta.0^{}"), firstSha);
      assert.equal(git("rev-parse", "v0.3.1^{}"), firstSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
