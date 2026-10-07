// @test-scope ./review-git-transport-reader.ts
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchCheckpointPack } from "./review-git-transport.js";
import { gitPacket } from "./review-git-pack-protocol.js";

const revision = "a".repeat(40);
const advertisement = Buffer.concat([
  gitPacket("# service=git-upload-pack\n"),
  Buffer.from("0000"),
  gitPacket(`${revision} HEAD\0shallow side-band-64k\n`),
  Buffer.from("0000"),
]);
const packed = Buffer.concat([
  gitPacket("NAK\n"),
  gitPacket("\x01PACK12345678"),
  Buffer.from("0000"),
]);
function response(body: Buffer, type: string, complete = true) {
  const value = new IncomingMessage(new Socket());
  value.statusCode = 200;
  value.headers = { "content-type": type };
  value.complete = complete;
  value.push(body);
  value.push(null);
  return value;
}
function transport() {
  let reads = 0;
  return async () =>
    ++reads === 1
      ? response(advertisement, "application/x-git-upload-pack-advertisement")
      : response(packed, "application/x-git-upload-pack-result");
}
describe("exact-checkpoint transfer bounds", () => {
  it("counts both complete response bodies at the exact allowance", async () => {
    const bytes = advertisement.length + packed.length;
    const result = await fetchCheckpointPack(
      { url: "https://example.test/repo.git" },
      revision,
      { wallMs: 1000, transferBytes: bytes },
      new AbortController().signal,
      transport(),
    );
    expect(result.transferBytes).toBe(bytes);
    expect(result.pack.toString()).toBe("PACK12345678");
  });
  it("rejects one byte over the shared allowance during the second response", async () => {
    const limit = advertisement.length + packed.length - 1;
    await expect(
      fetchCheckpointPack(
        { url: "https://example.test/repo.git" },
        revision,
        { wallMs: 1000, transferBytes: limit },
        new AbortController().signal,
        transport(),
      ),
    ).rejects.toMatchObject({
      resource: "transferBytes",
      observed: limit + 1,
      limit,
    });
  });
  it("rejects incomplete HTTP messages before trusting their protocol payload", async () => {
    await expect(
      fetchCheckpointPack(
        { url: "https://example.test/repo.git" },
        revision,
        { wallMs: 1000, transferBytes: 1000 },
        new AbortController().signal,
        async () =>
          response(
            advertisement,
            "application/x-git-upload-pack-advertisement",
            false,
          ),
      ),
    ).rejects.toMatchObject({ code: "GIT_FETCH_INCOMPLETE" });
  });
});
