// Reuse the PNG decoder shipped with the installed browser test dependency.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const browserRequire = createRequire(require.resolve("playwright"));
const { PNG } = require(
  join(
    dirname(browserRequire.resolve("playwright-core")),
    "lib/utilsBundle.js",
  ),
);

export function bandColors(buffer, box) {
  const png = PNG.sync.read(buffer);
  function mode(y) {
    const colors = new Map();
    for (
      let x = Math.ceil((box.left + 1) * box.dpr);
      x < Math.floor((box.right - 1) * box.dpr);
      x++
    ) {
      const offset = (Math.floor(y * box.dpr) * png.width + x) * 4;
      const color = [...png.data.subarray(offset, offset + 3)].join(",");
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
    return [...colors].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  return { gap: mode(box.top - 4), text: mode(box.bottom - 1) };
}

export function compareTrailPixels(before, after) {
  const first = PNG.sync.read(before);
  const second = PNG.sync.read(after);
  if (first.width !== second.width || first.height !== second.height)
    throw new Error("Trail screenshots have different dimensions");
  let differentPixels = 0;
  let maximumDifference = 0;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    let difference = 0;
    for (let channel = 0; channel < 4; channel++)
      difference = Math.max(
        difference,
        Math.abs(first.data[offset + channel] - second.data[offset + channel]),
      );
    if (difference > 1) differentPixels++;
    maximumDifference = Math.max(maximumDifference, difference);
  }
  return { differentPixels, maximumDifference };
}
