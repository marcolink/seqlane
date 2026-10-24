// @test-scope ./review-state-canonical.ts
// @test-scope ./review-state-bindings.ts
// @test-scope ../../../workflows/code-review/review-v5-state.ts
// @test-scope ../../../workflows/code-review/review-v5-findings.ts
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeReviewStateV5,
  encodeReviewStateV5,
} from "./review-state-codec.js";
import {
  createRetainedFindingFixture,
  createReviewStateFixture,
} from "./review-state-fixture.test-support.js";

function withPayload(body: string, payload: Uint8Array) {
  return body.replace(
    /("data":")[^"]+/,
    `$1${Buffer.from(payload).toString("base64")}`,
  );
}
describe("bounded v5 hidden state", () => {
  it("round trips deterministically with retained findings and exact identities", async () => {
    const state = createReviewStateFixture();
    state.findings = [createRetainedFindingFixture(state.reviewedRevision)];
    state.nextFindingIndex = 2;
    const body = encodeReviewStateV5(state);
    expect(encodeReviewStateV5(state)).toBe(body);
    expect(body).not.toContain("```json");
    expect((await decodeReviewStateV5(body)).state).toEqual(state);
  });
  it.each(["seqlane-code-review-meta-v5", "seqlane-code-review-state-v5"])(
    "rejects duplicated %s markers",
    async (marker) => {
      const body = encodeReviewStateV5(createReviewStateFixture());
      const line = body.split("\n").find((part) => part.includes(marker))!;
      await expect(decodeReviewStateV5(`${line}\n${body}`)).rejects.toThrow();
    },
  );
  it("rejects mismatched metadata and noncanonical JSON", async () => {
    const state = createReviewStateFixture();
    const body = encodeReviewStateV5(state);
    await expect(
      decodeReviewStateV5(
        body.replace(
          '"generation":"0123456789abcdef0123456789abcdef"',
          `"generation":"${"a".repeat(32)}"`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      decodeReviewStateV5(
        withPayload(body, gzipSync(JSON.stringify(state, null, 2))),
      ),
    ).rejects.toThrow();
  });
  it("rejects missing root markers and duplicated JSON identity keys", async () => {
    const body = encodeReviewStateV5(createReviewStateFixture());
    await expect(
      decodeReviewStateV5(body.replace("<!-- seqlane-code-review -->", "")),
    ).rejects.toThrow();
    await expect(
      decodeReviewStateV5(
        body.replace(
          '"repositoryId":"1"',
          '"repositoryId":"1","repositoryId":"1"',
        ),
      ),
    ).rejects.toThrow();
    await expect(
      decodeReviewStateV5(
        body.replace(
          '"encoding":"gzip+base64"',
          '"encoding":"gzip+base64","encoding":"gzip+base64"',
        ),
      ),
    ).rejects.toThrow();
  });
  it.each(["%%%", "A===", "AB==", "a".repeat(20_001)])(
    "rejects malformed, noncanonical, or oversized base64",
    async (data) => {
      const body = encodeReviewStateV5(createReviewStateFixture()).replace(
        /("data":")[^"]+/,
        `$1${data}`,
      );
      await expect(decodeReviewStateV5(body)).rejects.toThrow();
    },
  );
  it("accepts the decoder expansion boundary then rejects invalid schema", async () => {
    const body = encodeReviewStateV5(createReviewStateFixture());
    await expect(
      decodeReviewStateV5(withPayload(body, gzipSync(" ".repeat(512_000)))),
    ).rejects.toMatchObject({
      code: "REVIEW_STATE_DECODE_FAILED",
      cause: expect.not.objectContaining({
        message: "Expanded state exceeds byte limit",
      }),
    });
    await expect(
      decodeReviewStateV5(withPayload(body, gzipSync(" ".repeat(512_001)))),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "Expanded state exceeds byte limit",
      }),
    });
  });
  it("rejects compressed data past the boundary before decompression", async () => {
    const body = encodeReviewStateV5(createReviewStateFixture());
    await expect(
      decodeReviewStateV5(withPayload(body, Buffer.alloc(15_001))),
    ).rejects.toThrow();
    await expect(
      decodeReviewStateV5(withPayload(body, Buffer.alloc(15_000))),
    ).rejects.toMatchObject({
      cause: expect.not.objectContaining({
        message: "Compressed state is oversized or noncanonical",
      }),
    });
  });
  it.each([Buffer.from([255]), Buffer.from("not json")])(
    "rejects malformed UTF-8 and JSON",
    async (bytes) => {
      await expect(
        decodeReviewStateV5(
          withPayload(
            encodeReviewStateV5(createReviewStateFixture()),
            gzipSync(bytes),
          ),
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects invalid gzip and state inside a fence", async () => {
    const body = encodeReviewStateV5(createReviewStateFixture());
    await expect(
      decodeReviewStateV5(withPayload(body, Buffer.from("not gzip"))),
    ).rejects.toThrow();
    await expect(decodeReviewStateV5(`\`\`\`\n${body}`)).rejects.toThrow();
  });
  it("honors cancellation before decoding", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeReviewStateV5(
        encodeReviewStateV5(createReviewStateFixture()),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
  it("rejects corrupted finding and excerpt digests", () => {
    const state = createReviewStateFixture();
    state.findings = [createRetainedFindingFixture(state.reviewedRevision)];
    state.nextFindingIndex = 2;
    state.findings[0]!.identityKey = "0".repeat(64);
    expect(() => encodeReviewStateV5(state)).toThrow("identity digest");
    state.findings = [createRetainedFindingFixture(state.reviewedRevision)];
    const evidence = state.findings[0]!.evidence;
    if (evidence.anchorKind === "changed-text")
      evidence.excerpt.excerptDigest = "0".repeat(64);
    expect(() => encodeReviewStateV5(state)).toThrow("excerpt digest");
  });
});
