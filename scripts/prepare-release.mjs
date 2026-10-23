import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ReleaseClient } from "nx/release";
import { z } from "zod";

const repositoryRoot = new URL("../", import.meta.url);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const releaseVersionSchema = z.string().regex(semverPattern);
const channelVersionSchemas = {
  main: releaseVersionSchema.regex(/^[^-+]+$/),
  next: releaseVersionSchema.regex(/-beta\.\d+$/),
};
const releaseBranchSchema = z.enum(["main", "next"]);
const nxJsonSchema = z.looseObject({
  release: z.looseObject({
    version: z.looseObject({}),
    changelog: z.looseObject({ workspaceChangelog: z.looseObject({}) }),
  }),
});

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
  if (!releaseVersionSchema.safeParse(version).success) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return version;
}

function releaseTagsAtHead(branch) {
  const tags = lines(
    git(["tag", "--points-at", "HEAD", "--list", "v*"]).stdout,
  );
  const releaseTags = tags.filter((tag) => {
    if (tag.split(".").length < 3) return false;
    return channelVersionSchemas[branch].safeParse(releaseVersionFromTag(tag))
      .success;
  });
  if (releaseTags.length > 1) {
    throw new Error("The triggering commit has multiple release tags");
  }
  return releaseTags;
}

function previousReleaseTag(revision, branch) {
  const parent = git(["rev-parse", "--verify", `${revision}^`], {
    allowFailure: true,
  });
  if (parent.status !== 0) return undefined;

  return lines(
    git([
      // Match Nx's stable-over-beta precedence for the same base version.
      "-c",
      "versionsort.suffix=-beta.",
      "tag",
      "--merged",
      parent.stdout.trim(),
      "--list",
      "v*",
      "--sort=-v:refname",
    ]).stdout,
  ).find((tag) => {
    try {
      const version = releaseVersionFromTag(tag);
      return (
        channelVersionSchemas.main.safeParse(version).success ||
        channelVersionSchemas[branch].safeParse(version).success
      );
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
  const release = structuredClone(nxJsonSchema.parse(nxJson).release);
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
    async calculateVersion({ firstRelease, preid }) {
      const result = await client.releaseVersion({
        dryRun: true,
        firstRelease,
        preid,
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

async function recoverRelease({ adapter, releaseTag, revision, branch }) {
  const version = releaseVersionFromTag(releaseTag);
  verifyRemoteTag(releaseTag, revision);
  const previousTag = previousReleaseTag(revision, branch);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  // Nx must recalculate from the history before any release on this commit.
  const hiddenTags =
    branch === "next"
      ? [releaseTag, ...releaseTagsAtHead("main")]
      : [releaseTag];
  const tagObjects = hiddenTags.map((tag) => [
    tag,
    git(["rev-parse", `refs/tags/${tag}`]).stdout.trim(),
  ]);

  let calculatedVersion;
  try {
    for (const [tag] of tagObjects)
      git(["update-ref", "-d", `refs/tags/${tag}`]);
    calculatedVersion = await adapter.calculateVersion({
      firstRelease,
      preid: branch === "next" ? "beta" : undefined,
    });
  } finally {
    for (const [tag, object] of tagObjects)
      git(["update-ref", `refs/tags/${tag}`, object]);
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
  if (branch === "next") args.push("--prerelease", "--latest=false");
  command("gh", args, { inherit: true });

  return { firstRelease, releaseTag, released: true, state: "recover" };
}

async function createRelease({ revision, branch }) {
  const currentHead = git(["rev-parse", `origin/${branch}`]).stdout.trim();
  if (currentHead !== revision) {
    throw new Error(
      `${branch} advanced to ${currentHead} after this workflow started at ${revision}`,
    );
  }

  const previousTag = previousReleaseTag(revision, branch);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  const args = ["exec", "nx", "release", "--skip-publish"];
  if (firstRelease) args.push("--first-release");
  if (branch === "next") args.push("--preid", "beta");
  command("pnpm", args, { inherit: true });

  const releaseTags = releaseTagsAtHead(branch);
  if (releaseTags.length === 0) {
    return { firstRelease, released: false, state: "new" };
  }
  const releaseTag = releaseTags[0];
  verifyRemoteTag(releaseTag, revision);
  return { firstRelease, releaseTag, released: true, state: "new" };
}

export async function prepareRelease({ revision, branch }) {
  z.string()
    .regex(/^[0-9a-f]{40}$/)
    .parse(revision);
  releaseBranchSchema.parse(branch);

  git(["fetch", "--tags", "--force", "origin"], { inherit: true });
  git(["fetch", "--no-tags", "origin", branch], { inherit: true });
  git(["switch", "--force-create", branch, revision], { inherit: true });
  git(["branch", `--set-upstream-to=origin/${branch}`, branch]);

  const [releaseTag] = releaseTagsAtHead(branch);
  if (releaseTag) {
    const adapter = await loadNxAdapter();
    return recoverRelease({ adapter, releaseTag, revision, branch });
  }
  return createRelease({ revision, branch });
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
    branch: process.env.GITHUB_REF_NAME ?? "",
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
