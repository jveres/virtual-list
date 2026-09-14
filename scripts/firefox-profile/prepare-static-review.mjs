// Create disposable, source-isolated experiments. Never overwrite src/ or demos/.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
if (
  execFileSync("git", ["diff", "HEAD", "--", "src", "demos", "integrations"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
) {
  throw new Error("Experiments require unchanged runtime and demos");
}
mkdirSync(join(root, "browser-artifacts"), { recursive: true });
const output = mkdtempSync(join(root, "browser-artifacts/static-review-"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const patches = {
  baseline: [],
  resident: [
    [
      "src/premeasure.ts",
      [
        [
          "      measureRoot.replaceChildren(...elements.map(positionRowElement));",
          `      // Experimental bounded residency: only a single measured row survives.
      // Do not remove/reinsert an unchanged resident on each token.
      const same = elements.length === 1 && measureRoot.childNodes.length === 1 &&
        measureRoot.firstChild === elements[0];
      if (!same) measureRoot.replaceChildren(...elements.map(positionRowElement));`,
        ],
        [
          "        measureRoot.replaceChildren();",
          "        if (elements.length !== 1) measureRoot.replaceChildren();",
        ],
      ],
    ],
  ],
  paging: [
    [
      "src/paging.ts",
      [
        [
          `    const nextPages = pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        options.key(item) === key ? next : item,
      ),
    }));`,
          `    const nextPages = pages.map((page) => {
      const owned = page.items.findIndex((item) => options.key(item) === key);
      if (owned < 0) return page;
      const replacements = page.items.slice();
      replacements[owned] = next;
      return { ...page, items: replacements };
    });`,
        ],
        [
          "    items = items.map((item, itemIndex) => (itemIndex === index ? next : item));",
          "    const flat = items.slice();\n    flat[index] = next;\n    items = flat;",
        ],
      ],
    ],
  ],
  stage64: [
    ["src/virtual-list.ts", [["batch.length < 8", "batch.length < 64"]]],
  ],
};
for (const [variant, files] of Object.entries(patches)) {
  const destination = join(output, variant);
  mkdirSync(destination);
  for (const directory of ["src", "demos", "examples", "integrations"])
    cpSync(join(root, directory), join(destination, directory), {
      recursive: true,
    });
  for (const [file, replacements] of files) {
    const path = join(destination, file);
    let source = readFileSync(path, "utf8");
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2)
        throw new Error(`Ambiguous patch: ${variant}/${file}`);
      source = source.replace(before, after);
    }
    writeFileSync(path, source);
  }
}
writeFileSync(
  join(output, "experiment.json"),
  JSON.stringify(
    {
      revision,
      variants: Object.keys(patches),
      purpose: "Performance experiments only; not production patches",
    },
    null,
    2,
  ),
);
console.log(output);
