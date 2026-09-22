import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ReleaseClient } from "nx/release";

const repositoryRoot = new URL("../", import.meta.url);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: options.inherit ? "inherit" : "pipe",
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${commandName} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }

  return result;
}

function git(args, options) {
  return command("git", args, options);
}

function lines(value) {
  return value
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function releaseVersionFromTag(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return version;
}

function releaseTagsAtHead() {
  const tags = lines(
    git(["tag", "--points-at", "HEAD", "--list", "v*"]).stdout,
  );
  const releaseTags = tags.filter((tag) => {
    if (tag.split(".").length < 3) return false;
    releaseVersionFromTag(tag);
    return true;
  });
  if (releaseTags.length > 1) {
    throw new Error("The triggering commit has multiple release tags");
  }
  return releaseTags;
}

function previousReleaseTag(revision) {
  const parent = git(["rev-parse", "--verify", `${revision}^`], {
    allowFailure: true,
  });
  if (parent.status !== 0) return undefined;

  return lines(
    git([
      "tag",
      "--merged",
      parent.stdout.trim(),
      "--list",
      "v*",
      "--sort=-v:refname",
    ]).stdout,
  ).find((tag) => {
    try {
      releaseVersionFromTag(tag);
      return true;
    } catch {
      return false;
    }
  });
}

function verifyRemoteTag(tag, revision) {
  const refs = lines(
    git([
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]).stdout,
  );
  const peeled = refs.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = refs.find((line) => line.endsWith(`refs/tags/${tag}`));
  const target = (peeled ?? direct)?.split(/\s+/)[0];
  if (target !== revision) {
    throw new Error(`Release tag ${tag} is not a remote tag for ${revision}`);
  }
}

export function releaseClientConfig(nxJson) {
  const release = structuredClone(nxJson.release);
  delete release.git;
  release.changelog = {
    ...release.changelog,
    git: { commit: false, push: false, tag: false },
    workspaceChangelog: {
      ...release.changelog.workspaceChangelog,
      createRelease: false,
    },
  };
  release.version = {
    ...release.version,
    git: { commit: false, tag: false },
  };
  return release;
}

function defaultNxAdapter() {
  const nxJson = JSON.parse(
    readFileSync(new URL("nx.json", repositoryRoot), "utf8"),
  );
  const client = new ReleaseClient(releaseClientConfig(nxJson), true);
  return {
    async calculateVersion({ firstRelease }) {
      const result = await client.releaseVersion({
        dryRun: true,
        firstRelease,
        gitCommit: false,
        gitTag: false,
        stageChanges: false,
      });
      return result.workspaceVersion;
    },
    async generateChangelog({ firstRelease, from, to, version }) {
      await client.releaseChangelog({
        createRelease: false,
        firstRelease,
        from,
        gitCommit: false,
        gitPush: false,
        gitTag: false,
        to,
        version,
      });
    },
    async restoreVersion(version) {
      await client.releaseVersion({
        gitCommit: false,
        gitPush: false,
        gitTag: false,
        specifier: version,
        stageChanges: false,
      });
    },
  };
}

async function loadNxAdapter() {
  const adapterPath = process.env.SEQLANE_RELEASE_NX_ADAPTER;
  if (!adapterPath) return defaultNxAdapter();
  const absolutePath = isAbsolute(adapterPath)
    ? adapterPath
    : resolve(process.cwd(), adapterPath);
  return import(pathToFileURL(absolutePath).href);
}

async function recoverRelease({ adapter, releaseTag, revision }) {
  const version = releaseVersionFromTag(releaseTag);
  verifyRemoteTag(releaseTag, revision);
  const previousTag = previousReleaseTag(revision);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  const tagObject = git(["rev-parse", `refs/tags/${releaseTag}`]).stdout.trim();

  git(["update-ref", "-d", `refs/tags/${releaseTag}`]);
  let calculatedVersion;
  try {
    calculatedVersion = await adapter.calculateVersion({ firstRelease });
  } finally {
    git(["update-ref", `refs/tags/${releaseTag}`, tagObject]);
  }
  if (calculatedVersion !== version) {
    throw new Error(
      `Release tag ${releaseTag} does not match Nx version ${calculatedVersion ?? "none"}`,
    );
  }

  await adapter.restoreVersion(version);
  await adapter.generateChangelog({
    firstRelease,
    from: previousTag,
    to: revision,
    version,
  });

  const view = command("gh", ["release", "view", releaseTag], {
    allowFailure: true,
  });
  const action = view.status === 0 ? "edit" : "create";
  const args = ["release", action, releaseTag];
  if (action === "create") args.push("--verify-tag");
  args.push("--title", releaseTag, "--notes-file", "CHANGELOG.md");
  command("gh", args, { inherit: true });

  return { firstRelease, releaseTag, released: true, state: "recover" };
}

async function createRelease({ revision }) {
  const currentMain = git(["rev-parse", "origin/main"]).stdout.trim();
  if (currentMain !== revision) {
    throw new Error(
      `main advanced to ${currentMain} after this workflow started at ${revision}`,
    );
  }

  const previousTag = previousReleaseTag(revision);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  const args = ["exec", "nx", "release", "--skip-publish"];
  if (firstRelease) args.push("--first-release");
  command("pnpm", args, { inherit: true });

  const releaseTags = releaseTagsAtHead();
  if (releaseTags.length === 0) {
    return { firstRelease, released: false, state: "new" };
  }
  const releaseTag = releaseTags[0];
  verifyRemoteTag(releaseTag, revision);
  return { firstRelease, releaseTag, released: true, state: "new" };
}

export async function prepareRelease({ revision }) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`Invalid release revision: ${revision}`);
  }

  git(["fetch", "--tags", "--force", "origin"], { inherit: true });
  git(["fetch", "--no-tags", "origin", "main"], { inherit: true });
  git(["switch", "--force-create", "main", revision], { inherit: true });

  const [releaseTag] = releaseTagsAtHead();
  if (releaseTag) {
    const adapter = await loadNxAdapter();
    return recoverRelease({ adapter, releaseTag, revision });
  }
  return createRelease({ revision });
}

function outputPathFromArgs() {
  const index = process.argv.indexOf("--output");
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("Usage: prepare-release.mjs --output <path>");
  }
  return process.argv[index + 1];
}

async function main() {
  const result = await prepareRelease({
    revision: process.env.GITHUB_SHA ?? "",
  });
  writeFileSync(outputPathFromArgs(), `${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
