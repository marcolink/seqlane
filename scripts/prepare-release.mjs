import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ReleaseClient } from "nx/release";
import { z } from "zod";

import {
  betaVersionSchema,
  channelVersion,
  compareVersions,
  releaseChannel,
  releaseRevisionSchema,
  releaseVersionSchema,
  stableVersionSchema,
} from "./release-channel.mjs";

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

function releaseTagsAtHead(channel) {
  const tags = lines(
    git(["tag", "--points-at", "HEAD", "--list", "v*"]).stdout,
  );
  const releaseTags = tags.filter((tag) => {
    if (tag.split(".").length < 3) return false;
    const version = releaseVersionFromTag(tag);
    return channel.versionSchema.safeParse(version).success;
  });
  if (releaseTags.length > 1) {
    throw new Error("The triggering commit has multiple release tags");
  }
  return releaseTags;
}

function tagsMergedInto(revision) {
  return lines(
    git(["tag", "--merged", revision, "--list", "v*", "--sort=-v:refname"])
      .stdout,
  ).filter((tag) => releaseVersionSchema.safeParse(tag.slice(1)).success);
}

function previousReleaseTag(revision, channel) {
  const parent = git(["rev-parse", "--verify", `${revision}^`], {
    allowFailure: true,
  });
  if (parent.status !== 0) return undefined;

  const tags = tagsMergedInto(parent.stdout.trim());
  const stable = tags.find(
    (tag) => stableVersionSchema.safeParse(tag.slice(1)).success,
  );
  if (channel.branch === "main") return stable;
  const beta = tags.find(
    (tag) => betaVersionSchema.safeParse(tag.slice(1)).success,
  );
  return beta &&
    (!stable ||
      compareVersions(beta.slice(1).split("-")[0], stable.slice(1)) > 0)
    ? beta
    : stable;
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

async function calculateNxVersion({
  client,
  seriesClient,
  channel,
  firstRelease,
}) {
  const options = {
    dryRun: true,
    firstRelease,
    gitCommit: false,
    gitTag: false,
    stageChanges: false,
    preid: channel.preid,
  };
  const result = await client.releaseVersion(options);
  const version = result.workspaceVersion;
  const previous = previousReleaseTag("HEAD", channel);
  if (
    !version ||
    channel.branch === "main" ||
    (previous && betaVersionSchema.safeParse(previous.slice(1)).success)
  )
    return version;
  // Reserve at least a minor series without changing Nx's pre-1.0 breaking-change rules.
  const minor = await seriesClient.releaseVersion({
    ...options,
    specifier: "preminor",
  });
  return compareVersions(minor.workspaceVersion, version) > 0
    ? minor.workspaceVersion
    : version;
}

export function defaultNxAdapter(channel = releaseChannel("main")) {
  const nxJson = JSON.parse(readFileSync("nx.json", "utf8"));
  const config = releaseClientConfig(nxJson);
  const client = new ReleaseClient(config, true);
  const seriesClient = new ReleaseClient(
    {
      ...config,
      version: {
        ...config.version,
        adjustSemverBumpsForZeroMajorVersion: false,
      },
    },
    true,
  );
  return {
    async calculateVersion({ firstRelease }) {
      return calculateNxVersion({
        client,
        seriesClient,
        channel,
        firstRelease,
      });
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
    async createRelease({ firstRelease, version, from, to }) {
      await this.restoreVersion(version);
      await client.releaseChangelog({
        firstRelease,
        version,
        from,
        to,
        createRelease: false,
        gitCommit: false,
        gitTag: true,
        gitPush: true,
        stageChanges: false,
      });
    },
  };
}

async function loadNxAdapter(channel) {
  const adapterPath = process.env.SEQLANE_RELEASE_NX_ADAPTER;
  if (!adapterPath) return defaultNxAdapter(channel);
  const absolutePath = isAbsolute(adapterPath)
    ? adapterPath
    : resolve(process.cwd(), adapterPath);
  return import(pathToFileURL(absolutePath).href);
}

function promotionVersion(version, revision, channel) {
  if (!version || channel.branch === "next") return version;
  const beta = tagsMergedInto(revision).find(
    (tag) => betaVersionSchema.safeParse(tag.slice(1)).success,
  );
  if (!beta) return version;
  const target = beta.slice(1).split("-")[0];
  const stable = previousReleaseTag(revision, releaseChannel("main"));
  if (stable && compareVersions(target, stable.slice(1)) <= 0) return version;
  if (compareVersions(version, target) > 0)
    throw new Error(
      "Stable changes exceed the accepted beta target; publish a new beta series first",
    );
  return target;
}

function publishGitHubRelease(releaseTag, channel) {
  const view = command("gh", ["release", "view", releaseTag], {
    allowFailure: true,
  });
  const action = view.status === 0 ? "edit" : "create";
  const args = ["release", action, releaseTag];
  if (action === "create") args.push("--verify-tag");
  const latestStable = tagsMergedInto("origin/main").find(
    (tag) => stableVersionSchema.safeParse(tag.slice(1)).success,
  );
  const latest =
    channel.branch === "main" &&
    (!latestStable ||
      compareVersions(releaseTag.slice(1), latestStable.slice(1)) >= 0);
  args.push(
    "--title",
    releaseTag,
    "--notes-file",
    "CHANGELOG.md",
    `--prerelease=${channel.branch === "next"}`,
    `--latest=${latest}`,
  );
  command("gh", args, { inherit: true });
}

async function recoverRelease({ adapter, releaseTag, revision, channel }) {
  const version = releaseVersionFromTag(releaseTag);
  verifyRemoteTag(releaseTag, revision);
  const previousTag = previousReleaseTag(revision, channel);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  const hiddenTags = [releaseTag];
  if (channel.branch === "next")
    hiddenTags.push(...releaseTagsAtHead(releaseChannel("main")));
  const tagObjects = hiddenTags.map((tag) => [
    tag,
    git(["rev-parse", `refs/tags/${tag}`]).stdout.trim(),
  ]);
  let calculatedVersion;
  try {
    for (const [tag] of tagObjects)
      git(["update-ref", "-d", `refs/tags/${tag}`]);
    calculatedVersion = promotionVersion(
      await adapter.calculateVersion({ firstRelease }),
      revision,
      channel,
    );
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
    from: previousReleaseTag(revision, releaseChannel("main")),
    to: revision,
    version,
  });

  publishGitHubRelease(releaseTag, channel);

  return {
    firstRelease,
    releaseTag,
    released: true,
    state: "recover",
    branch: channel.branch,
    distTag: channel.distTag,
  };
}

async function createRelease({ revision, channel, adapter }) {
  const currentHead = git([
    "rev-parse",
    `origin/${channel.branch}`,
  ]).stdout.trim();
  if (currentHead !== revision) {
    throw new Error(
      `${channel.branch} advanced to ${currentHead} after this workflow started at ${revision}`,
    );
  }

  const previousTag = previousReleaseTag(revision, channel);
  const firstRelease = !previousTag || previousTag === "v0.0.0";
  const calculated = await adapter.calculateVersion({ firstRelease });
  const version = promotionVersion(calculated, revision, channel);
  if (!version) {
    return {
      firstRelease,
      released: false,
      state: "new",
      branch: channel.branch,
      distTag: channel.distTag,
    };
  }
  channelVersion(version, channel);
  if (channel.branch === "next") {
    const stable = tagsMergedInto("origin/main").find(
      (tag) => stableVersionSchema.safeParse(tag.slice(1)).success,
    );
    if (stable && compareVersions(version.split("-")[0], stable.slice(1)) <= 0)
      throw new Error("Beta target is already stable; select a higher target");
  }
  await adapter.createRelease({
    firstRelease,
    version,
    from: previousReleaseTag(revision, releaseChannel("main")),
    to: revision,
  });
  const releaseTag = `v${version}`;
  verifyRemoteTag(releaseTag, revision);
  publishGitHubRelease(releaseTag, channel);
  return {
    firstRelease,
    releaseTag,
    released: true,
    state: "new",
    branch: channel.branch,
    distTag: channel.distTag,
  };
}

export async function prepareRelease({ revision, branch }) {
  releaseRevisionSchema.parse(revision);
  const channel = releaseChannel(branch);

  git(["fetch", "--tags", "origin"], { inherit: true });
  git(["fetch", "--no-tags", "origin", "main", channel.branch], {
    inherit: true,
  });
  git(["switch", "--force-create", channel.branch, revision], {
    inherit: true,
  });
  git(["branch", `--set-upstream-to=origin/${channel.branch}`, channel.branch]);

  const [releaseTag] = releaseTagsAtHead(channel);
  const adapter = await loadNxAdapter(channel);
  if (releaseTag) {
    return recoverRelease({ adapter, releaseTag, revision, channel });
  }
  return createRelease({ revision, channel, adapter });
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
    branch: process.env.GITHUB_REF_NAME,
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
