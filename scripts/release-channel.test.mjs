import assert from "node:assert/strict";
import test from "node:test";
import {
  channelVersion,
  compareVersions,
  releaseChannel,
} from "./release-channel.mjs";

test("release channels reject untrusted branches and mismatched versions", () => {
  for (const branch of [
    undefined,
    "feature",
    "refs/heads/next",
    "next; echo bad",
  ])
    assert.throws(() => releaseChannel(branch));
  assert.equal(
    channelVersion("0.3.0-beta.0", releaseChannel("next")),
    "0.3.0-beta.0",
  );
  for (const version of [
    "0.3.0",
    "0.3.0-beta.01",
    "0.3.0-rc.0",
    "0.3.0-beta.0+build",
  ])
    assert.throws(() => channelVersion(version, releaseChannel("next")));
  assert.throws(() => channelVersion("0.3.0-beta.0", releaseChannel("main")));
});

test("release order compares numeric beta counters and stable promotion", () => {
  assert.equal(compareVersions("0.3.0-beta.10", "0.3.0-beta.9"), 1);
  assert.equal(compareVersions("0.3.0", "0.3.0-beta.10"), 1);
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("0.2.1", "0.3.0-beta.0"), -1);
  assert.equal(compareVersions("0.3.0-beta.0", "0.3.0-beta.0"), 0);
});
