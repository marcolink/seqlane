import { ReviewScopeError } from "./review-scope-errors.js";

export function gitPacket(value: string): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}

export function parseGitPackets(bytes: Uint8Array): Buffer[] {
  const buffer = Buffer.from(bytes);
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const prefix = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/.test(prefix)) throw protocolError();
    const length = Number.parseInt(prefix, 16);
    offset += 4;
    if (length === 0) continue;
    if (length < 4 || offset + length - 4 > buffer.length)
      throw protocolError();
    packets.push(buffer.subarray(offset, offset + length - 4));
    offset += length - 4;
  }
  return packets;
}

export function checkpointFetchBody(
  advertisement: Uint8Array,
  revision: string,
): Buffer {
  const packets = parseGitPackets(advertisement);
  const firstRef = packets.find((packet) => packet.includes(0));
  if (
    packets[0]?.toString() !== "# service=git-upload-pack\n" ||
    firstRef === undefined
  )
    throw protocolError();
  const capabilities = new Set(
    firstRef
      .subarray(firstRef.indexOf(0) + 1)
      .toString("ascii")
      .trim()
      .split(" "),
  );
  if (
    !capabilities.has("side-band-64k") ||
    !capabilities.has("shallow") ||
    (revision.length === 64 && !capabilities.has("object-format=sha256")) ||
    (revision.length === 40 && capabilities.has("object-format=sha256"))
  )
    throw protocolError();
  const requested = ["side-band-64k", "no-progress", "ofs-delta"].filter(
    (capability) => capabilities.has(capability),
  );
  if (revision.length === 64) requested.push("object-format=sha256");
  return Buffer.concat([
    gitPacket(`want ${revision} ${requested.join(" ")}\n`),
    gitPacket("deepen 1\n"),
    Buffer.from("0000"),
    gitPacket("done\n"),
  ]);
}

export function checkpointPack(response: Uint8Array): Buffer {
  const chunks: Buffer[] = [];
  for (const packet of parseGitPackets(response)) {
    if (packet[0] === 1) chunks.push(packet.subarray(1));
    else if (packet[0] === 2) continue;
    else if (packet[0] === 3 || packet.toString().startsWith("ERR ")) {
      throw new ReviewScopeError(
        "CHECKPOINT_UNAVAILABLE",
        "The trusted remote refused the exact checkpoint.",
      );
    } else if (
      !/^(?:NAK\n?|ACK (?:[0-9a-f]{40}|[0-9a-f]{64})(?: (?:continue|common|ready))?\n?|(?:un)?shallow (?:[0-9a-f]{40}|[0-9a-f]{64})\n?)$/.test(
        packet.toString("ascii"),
      )
    )
      throw protocolError();
  }
  if (Buffer.from(response).subarray(-4).toString("ascii") !== "0000")
    throw protocolError();
  const pack = Buffer.concat(chunks);
  if (pack.length < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK")
    throw protocolError();
  return pack;
}

function protocolError() {
  return new ReviewScopeError(
    "GIT_FETCH_PROTOCOL",
    "The trusted remote returned unsupported or incomplete Git transport data.",
  );
}
