import { describe, expect, it } from "vitest";
import {
  gitPacket,
  checkpointFetchBody,
  checkpointPack,
  parseGitPackets,
} from "./review-git-pack-protocol.js";

const revision = "a".repeat(40);
function advertisement(
  capabilities = "shallow side-band-64k no-progress ofs-delta",
) {
  return Buffer.concat([
    gitPacket("# service=git-upload-pack\n"),
    Buffer.from("0000"),
    gitPacket(`${revision} HEAD\0${capabilities}\n`),
    Buffer.from("0000"),
  ]);
}
describe("exact-checkpoint Git transport protocol", () => {
  it("requests only advertised optional capabilities", () => {
    expect(
      checkpointFetchBody(
        advertisement("shallow side-band-64k"),
        revision,
      ).toString(),
    ).toContain(`want ${revision} side-band-64k\n`);
  });
  it("requests one exact shallow commit without thin packs or alternate URIs", () => {
    const packets = parseGitPackets(
      checkpointFetchBody(advertisement(), revision),
    ).map((packet) => packet.toString());
    expect(packets).toEqual([
      `want ${revision} side-band-64k no-progress ofs-delta\n`,
      "deepen 1\n",
      "done\n",
    ]);
  });
  it("requires SHA-256 capability for full SHA-256 checkpoint IDs", () => {
    expect(() =>
      checkpointFetchBody(advertisement(), "a".repeat(64)),
    ).toThrow();
    expect(
      checkpointFetchBody(
        advertisement("shallow side-band-64k object-format=sha256"),
        "a".repeat(64),
      ).toString(),
    ).toContain("object-format=sha256");
  });
  it("extracts only pack sideband bytes", () => {
    const pack = Buffer.from("PACK12345678");
    const response = Buffer.concat([
      gitPacket("NAK\n"),
      gitPacket("\x02progress\n"),
      gitPacket("\x01" + pack.toString()),
      Buffer.from("0000"),
    ]);
    expect(checkpointPack(response)).toEqual(pack);
  });
  it.each([
    Buffer.from("0003"),
    Buffer.from("fffftruncated"),
    Buffer.from("xxxx"),
    Buffer.from("0005"),
  ])("rejects malformed or incomplete frames", (value) => {
    expect(() => parseGitPackets(value)).toThrow();
  });
  it("refuses server errors without returning the remote error body", () => {
    expect(() =>
      checkpointPack(
        Buffer.concat([
          gitPacket("\x03credential secret"),
          Buffer.from("0000"),
        ]),
      ),
    ).toThrowError(/refused the exact checkpoint/);
  });
  it("accepts shallow metadata without a trailing newline", () => {
    expect(
      checkpointPack(
        Buffer.concat([
          gitPacket(`shallow ${revision}`),
          gitPacket("NAK"),
          gitPacket("\x01PACK12345678"),
          Buffer.from("0000"),
        ]),
      ).toString(),
    ).toBe("PACK12345678");
  });
  it("rejects missing terminal flush and malformed control object IDs", () => {
    expect(() => checkpointPack(gitPacket("\x01PACK12345678"))).toThrow();
    expect(() =>
      checkpointPack(
        Buffer.concat([
          gitPacket("shallow abc\n"),
          gitPacket("\x01PACK12345678"),
          Buffer.from("0000"),
        ]),
      ),
    ).toThrow();
  });
});
