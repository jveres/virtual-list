import { crc32, deflateSync } from "node:zlib";

export const imageFixtureSize = Object.freeze({ width: 960, height: 360 });

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

// Real indexed-color raster noise, generated before capture. Two bits per pixel
// keep ten distinct inline sources below the legacy localStorage seed quota.
export function imageFixture(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 10)
    throw new Error("Image fixture seed must be an integer from 1 to 10");
  const { width, height } = imageFixtureSize;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 2;
  header[9] = 3;
  const palette = Buffer.from([
    35, 56, 70, 83, 124, 145, 164, 183, 173, 226, 216, 179,
  ]);
  const stride = width / 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  let state = seed;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < stride; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[y * stride + x] = state & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", deflateSync(pixels, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
