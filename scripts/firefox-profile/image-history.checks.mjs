import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { chatWorkload } from "./chat-workload.mjs";
import { imageFixture, imageFixtureSize } from "./image-fixture.mjs";

const options = {
  history: 20,
  sections: 1,
  content: "prose",
  durationMs: 1000,
};

test("image history preserves the existing rich and tool fixtures", () => {
  for (const [historyContent, hash] of [
    [
      "rich",
      "850977a924dd5e94c9def90be53ee342900c8b86100050593fcc9b1b6f5f0927",
    ],
    [
      "tools",
      "c95e7dbf6242aecf7ffe5cad2d56b875958f665481c8a5c7d5e1416043635e7d",
    ],
  ])
    assert.equal(
      chatWorkload({ ...options, historyContent }).metadata.hash,
      hash,
    );
});

test("synthetic PNGs contain a valid known-size raster and seeded pixel noise", () => {
  const image = imageFixture(1);
  assert.deepEqual(image, imageFixture(1));
  assert.notDeepEqual(image, imageFixture(2));
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const chunks = new Map();
  for (let offset = 8; offset < image.length; ) {
    const length = image.readUInt32BE(offset);
    const end = offset + length + 12;
    const type = image.toString("ascii", offset + 4, offset + 8);
    assert.equal(
      crc32(image.subarray(offset + 4, end - 4)),
      image.readUInt32BE(end - 4),
    );
    chunks.set(type, image.subarray(offset + 8, end - 4));
    offset = end;
  }
  assert.deepEqual([...chunks.keys()], ["IHDR", "PLTE", "IDAT", "IEND"]);
  const header = chunks.get("IHDR");
  assert.equal(header.readUInt32BE(0), imageFixtureSize.width);
  assert.equal(header.readUInt32BE(4), imageFixtureSize.height);
  assert.equal(header[8], 2);
  assert.equal(header[9], 3);
  assert.equal(chunks.get("PLTE").length, 12);
  const pixels = inflateSync(chunks.get("IDAT"));
  const stride = imageFixtureSize.width / 4 + 1;
  assert.equal(pixels.length, stride * imageFixtureSize.height);
  for (let row = 0; row < imageFixtureSize.height; row++)
    assert.equal(
      pixels[row * stride],
      0,
      "each raster row uses the no-filter format",
    );
  assert.equal(
    new Set(pixels).size,
    256,
    "the payload contains pixel data, not padding",
  );
  assert.ok(image.length > 80 * 1024 && image.length < 100 * 1024);
  for (const seed of [0, 11, 1.5, NaN])
    assert.throws(() => imageFixture(seed), /seed must be an integer/);
});

test("image history has ten distinct inline rasters and stays within both seed budgets", () => {
  const rich = chatWorkload(options);
  const images = chatWorkload({ ...options, historyContent: "images" });
  assert.deepEqual(
    images,
    chatWorkload({ ...options, historyContent: "images" }),
  );
  assert.deepEqual(images.events, rich.events);
  assert.equal(images.turns.length, 20);
  const sources = new Set();
  let assetBytes = 0;
  let sourceBytes = 0;
  for (const [index, turn] of images.turns.entries()) {
    assert.equal(turn.sentAt, rich.turns[index].sentAt);
    if (turn.role === "user") {
      assert.deepEqual(turn, rich.turns[index]);
      continue;
    }
    assert.ok(turn.markdown.startsWith(rich.turns[index].markdown));
    const matches = [
      ...turn.markdown.matchAll(
        /<img src="(data:image\/png;base64,([^"]+))" width="960" height="360" alt="Synthetic raster \d+">/g,
      ),
    ];
    assert.equal(matches.length, 1);
    sources.add(matches[0][1]);
    sourceBytes += matches[0][1].length;
    assetBytes += Buffer.from(matches[0][2], "base64").length;
    assert.equal(turn.toolCalls, undefined);
  }
  const serialized = JSON.stringify(images.turns);
  assert.equal(sources.size, 10);
  assert.equal(images.metadata.historyImages, 10);
  assert.deepEqual(images.metadata.historyImageGenerator, {
    node: process.version,
    zlib: process.versions.zlib,
  });
  assert.deepEqual(images.metadata.historyImageSize, {
    width: 960,
    height: 360,
  });
  assert.equal(images.metadata.historyImageAssetBytes, assetBytes);
  assert.equal(images.metadata.historyImageSourceBytes, sourceBytes);
  assert.equal(images.metadata.historyJsonBytes, Buffer.byteLength(serialized));
  assert.equal(images.metadata.historyStorageBytes, serialized.length * 2);
  assert.ok(images.metadata.historyJsonBytes < 2 * 1024 ** 2);
  assert.ok(images.metadata.historyStorageBytes < 5 * 1024 ** 2);
});

test("partial or oversized image histories fail before browser launch", () => {
  for (const history of [19, 21, 160]) {
    assert.throws(
      () => chatWorkload({ ...options, history, historyContent: "images" }),
      /exactly 20 turns/,
    );
    const result = spawnSync(
      process.execPath,
      [
        new URL("../profile-chat.mjs", import.meta.url).pathname,
        "--history-content=images",
        `--history=${history}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly 20 turns/);
    assert.equal(result.stdout, "");
  }
});
