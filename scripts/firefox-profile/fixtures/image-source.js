import { buildChatItem } from "../../../demos/shared/chat-ui.ts";
import {
  initMarkdown,
  renderMarkdown,
} from "../../../demos/shared/markdown.ts";
import * as attachments from "../../../demos/streaming/attachments.ts";
import { createChatImagePreview } from "../../../demos/streaming/image-preview.ts";
import { appendStaticMessageContent } from "../../../demos/streaming/message-content.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
const { attachmentChip } = attachments;
// The frozen pre-optimization revision has no owned display URLs to release.
const disposeAttachmentChips = attachments.disposeAttachmentChips ?? (() => {});
await initMarkdown();
const metadata = await (await fetch("/__image-source/metadata")).json();
status.textContent =
  "Ready. Synthetic source lengths; no private images or scrolling.";
globalThis.imageSourceBenchmarkReady = true;

function syntheticImage(requestedLength) {
  const prefix = "data:image/png;base64,";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  context.fillStyle = "#6389a1";
  context.fillRect(0, 0, 64, 64);
  const original = Uint8Array.from(
    atob(canvas.toDataURL("image/png").split(",")[1]),
    (c) => c.charCodeAt(0),
  );
  const targetBytes = Math.floor((requestedLength - prefix.length) / 4) * 3;
  const textLength = targetBytes - original.length - 12;
  if (textLength < 8) throw new Error("Requested image source is too small");
  const bytes = new Uint8Array(targetBytes);
  const offset = original.length - 12;
  bytes.set(original.subarray(0, offset));
  new DataView(bytes.buffer).setUint32(offset, textLength);
  bytes.set([116, 69, 88, 116], offset + 4); // PNG tEXt, before IEND.
  bytes.set([67, 111, 109, 109, 101, 110, 116, 0], offset + 8);
  bytes.fill(120, offset + 16, offset + 8 + textLength);
  let crc = 0xffffffff;
  for (let i = offset + 4; i < offset + 8 + textLength; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  new DataView(bytes.buffer).setUint32(
    offset + 8 + textLength,
    (crc ^ 0xffffffff) >>> 0,
  );
  bytes.set(original.subarray(offset), targetBytes - 12);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 32768)
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return prefix + btoa(pieces.join(""));
}

globalThis.runImageSourceBenchmark = async ({
  lengths = [65536, 524288, 2097152],
  repeats = 5,
  iterations = 8,
  scenario = "image-source",
  orderedCache = "off",
} = {}) => {
  if (globalThis.imageSourceBenchmarkRunning)
    throw new Error("Benchmark already running");
  if (
    !Array.isArray(lengths) ||
    lengths.length > 8 ||
    !lengths.length ||
    lengths.some(
      (n) => !Number.isInteger(n) || n < 1024 || n > 8 * 1024 * 1024,
    ) ||
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > 20 ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 50 ||
    !["image-source", "ordered-content"].includes(scenario) ||
    !["off", "on"].includes(orderedCache)
  )
    throw new Error("Invalid benchmark bounds");
  if (scenario === "ordered-content" && !metadata.orderedContentProbe)
    throw new Error(
      "Ordered content scenario requires ORDERED_CONTENT_PROBE=1 server",
    );
  globalThis.imageSourceBenchmarkRunning = true;
  globalThis.imageSourceBenchmarkResult = undefined;
  const entries = [];
  let active = null;
  const restorers = [];
  const nativeObserver = globalThis.MutationObserver;
  let preview;
  let result;
  let cleanupError;
  const blobUrls = [];
  const correctness = [];
  const countCall = (key, action) => {
    if (!active) return action();
    const measured = active;
    measured[`${key}Count`] = (measured[`${key}Count`] ?? 0) + 1;
    const started = performance.now();
    try {
      return action();
    } finally {
      measured[`${key}Ms`] =
        (measured[`${key}Ms`] ?? 0) + performance.now() - started;
    }
  };
  try {
    const textCache = new Map();
    let cacheEnabled = orderedCache === "on";
    if (scenario === "ordered-content") {
      const previous = globalThis.__imageSourceBenchmarkRenderText;
      globalThis.__imageSourceBenchmarkRenderText = (
        message,
        key,
        text,
        render,
      ) =>
        countCall("renderRequest", () => {
          let parts = textCache.get(message.id);
          const cached = cacheEnabled ? parts?.get(key) : undefined;
          if (cached?.text === text) {
            if (active) active.cacheHits = (active.cacheHits ?? 0) + 1;
            return cached.html;
          }
          if (active)
            active.renderedChars = (active.renderedChars ?? 0) + text.length;
          const html = countCall("renderMarkdown", () => render(text));
          if (cacheEnabled) {
            if (!parts) {
              parts = new Map();
              textCache.set(message.id, parts);
            }
            parts.set(key, { text, html });
          }
          return html;
        });
      restorers.push(() => {
        if (previous === undefined)
          delete globalThis.__imageSourceBenchmarkRenderText;
        else globalThis.__imageSourceBenchmarkRenderText = previous;
      });
      const descriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "innerHTML",
      );
      if (!descriptor?.set || !descriptor.configurable)
        throw new Error("innerHTML instrumentation unavailable");
      Object.defineProperty(Element.prototype, "innerHTML", {
        ...descriptor,
        set(value) {
          if (!this.classList.contains("markdown"))
            return descriptor.set.call(this, value);
          if (active)
            active.htmlAssignedChars =
              (active.htmlAssignedChars ?? 0) + value.length;
          return countCall("innerHTML", () => descriptor.set.call(this, value));
        },
      });
      restorers.push(() =>
        Object.defineProperty(Element.prototype, "innerHTML", descriptor),
      );
    }
    for (const key of ["src", "currentSrc"]) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        key,
      );
      if (!descriptor?.get || !descriptor.configurable)
        throw new Error("Image getter instrumentation unavailable");
      Object.defineProperty(HTMLImageElement.prototype, key, {
        ...descriptor,
        get() {
          return countCall(`${key}Read`, () => descriptor.get.call(this));
        },
        ...(descriptor.set
          ? {
              set(value) {
                return countCall(`${key}Write`, () =>
                  descriptor.set.call(this, value),
                );
              },
            }
          : {}),
      });
      restorers.push(() =>
        Object.defineProperty(HTMLImageElement.prototype, key, descriptor),
      );
    }
    const getAttribute = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function (name) {
      return this instanceof HTMLImageElement && name === "src"
        ? countCall("srcAttributeRead", () => getAttribute.call(this, name))
        : getAttribute.call(this, name);
    };
    restorers.push(() => {
      Element.prototype.getAttribute = getAttribute;
    });
    globalThis.MutationObserver = class extends nativeObserver {
      constructor(callback) {
        super((records, observer) =>
          countCall("observer", () => callback(records, observer)),
        );
      }
    };
    const measure = async (
      name,
      length,
      repeat,
      action,
      operations = iterations,
    ) => {
      await delay();
      const metrics = {
        name,
        length,
        repeat,
        phase: repeat < 0 ? "cold" : "warm",
        operations,
      };
      active = metrics;
      const started = performance.now();
      await action();
      metrics.actionElapsedMs = performance.now() - started;
      await delay();
      active = null;
      entries.push(metrics);
    };
    for (const requestedLength of lengths) {
      const url = syntheticImage(requestedLength);
      if (scenario === "ordered-content") {
        const intro = "Opening paragraph.\n\nSecond opening paragraph.\n\n";
        const imageText = `![Synthetic image](${url})\n\n`;
        const tail = "Closing paragraph.";
        const call = (name, markdownOffset) => ({
          name,
          markdownOffset,
          status: "done",
          durationMs: 1,
          input: "synthetic input",
          output: "synthetic output",
          open: false,
        });
        const message = {
          id: 1,
          role: "assistant",
          markdown: intro + imageText + tail,
          toolCalls: [
            call("before_image", intro.length),
            call("after_image", intro.length + imageText.length),
          ],
        };
        const mount = (sample) => {
          const host = document.createElement("div");
          appendStaticMessageContent(host, sample);
          viewport.append(host);
          host.remove();
          return host;
        };
        textCache.clear();
        await measure(
          "ordered-content",
          url.length,
          -1,
          () => mount(message),
          1,
        );
        for (let repeat = 0; repeat < repeats; repeat++) {
          await measure("ordered-content", url.length, repeat, () => {
            for (let i = 0; i < iterations; i++) mount(message);
          });
        }
        for (const entry of entries.filter(
          (entry) =>
            entry.name === "ordered-content" && entry.length === url.length,
        )) {
          const calls = entry.operations * 3;
          const renders =
            entry.phase === "cold" || orderedCache === "off" ? calls : 0;
          if (
            entry.renderRequestCount !== calls ||
            (entry.renderMarkdownCount ?? 0) !== renders ||
            entry.innerHTMLCount !== calls
          )
            throw new Error(
              "Ordered-content attribution counts did not match actual work",
            );
        }
        // This is the existing ordinary-row cache path, not a new rendering implementation.
        const fullHtml = renderMarkdown(message.markdown);
        for (let repeat = 0; repeat < repeats; repeat++) {
          await measure("ordinary-cached-html", url.length, repeat, () => {
            for (let i = 0; i < iterations; i++) {
              const host = buildChatItem(
                { ...message, toolCalls: undefined },
                fullHtml,
              );
              viewport.append(host);
              host.remove();
            }
          });
        }
        // Validation deliberately runs after timing, never warming the candidate's cold cache.
        const changedText = {
          ...message,
          markdown: `${message.markdown} Updated tail.`,
        };
        const shifted = {
          ...message,
          toolCalls: message.toolCalls.map((tool, i) =>
            i === 0
              ? { ...tool, markdownOffset: intro.indexOf("Second") }
              : { ...tool },
          ),
        };
        const changedTool = {
          ...message,
          toolCalls: message.toolCalls.map((tool, i) =>
            i === 0
              ? { ...tool, output: "updated output", open: true }
              : { ...tool },
          ),
        };
        textCache.clear();
        for (const [name, sample] of [
          ["initial", message],
          ["same-id-edit", changedText],
          ["shifted-tool-offset", shifted],
          ["tool-output-and-open", changedTool],
        ]) {
          cacheEnabled = false;
          const expected = mount(sample);
          cacheEnabled = true;
          const actual = mount(sample);
          if (actual.innerHTML !== expected.innerHTML)
            throw new Error(`Ordered content cache changed DOM: ${name}`);
          if (
            actual.querySelectorAll("details").length !== 2 ||
            actual.querySelectorAll("img").length !== 1
          )
            throw new Error(`Ordered content shape changed: ${name}`);
          if (
            name === "initial" &&
            Array.from(actual.children, (node) =>
              node.classList.contains("tool-calls") ? "tool" : "text",
            ).join(",") !== "text,tool,text,tool,text"
          )
            throw new Error("Ordered content tool/text order changed");
          if (
            name === "tool-output-and-open" &&
            !actual.querySelector("details").open
          )
            throw new Error("Cached text prevented fresh tool state");
          correctness.push({ length: url.length, case: name, passed: true });
        }
        cacheEnabled = orderedCache === "on";
        continue;
      }
      const message = { id: 1, markdown: `![Synthetic image](${url})` };
      const attachment = {
        name: "synthetic.png",
        mimeType: "image/png",
        size: ((url.length - url.indexOf(",") - 1) / 4) * 3,
        dataUrl: url,
      };
      const row = document.createElement("div");
      row.dataset.key = "1";
      const image = document.createElement("img");
      image.src = url;
      row.append(image);
      viewport.replaceChildren(row);
      let decodeTimer;
      try {
        await Promise.race([
          image.decode(),
          new Promise((_, reject) => {
            decodeTimer = setTimeout(
              () => reject(new Error("Synthetic image decode timed out")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(decodeTimer);
      }
      if (!image.naturalWidth)
        throw new Error("Synthetic image failed to decode");
      // Decode and initial binding are outside the repeated mutation measurement.
      await measure(
        "preview-initial-bind",
        url.length,
        -1,
        () => {
          preview = createChatImagePreview(viewport, () => [message]);
        },
        1,
      );
      image.alt = "warmup";
      await delay();
      for (let repeat = 0; repeat < repeats; repeat++) {
        await measure("preview-row-mutation", url.length, repeat, async () => {
          for (let i = 0; i < iterations; i++) {
            const node = document.createElement("span");
            row.append(node);
            await delay();
            node.remove();
            await delay();
          }
        });
        await measure("preview-alt-mutation", url.length, repeat, async () => {
          for (let i = 0; i < iterations; i++) {
            image.alt = `sample-${repeat}-${i}`;
            await delay();
          }
        });
      }
      preview.dispose();
      preview = undefined;
      viewport.replaceChildren();
      // Identical object identity across repeats measures repeated row remounts.
      await measure(
        "attachment-construction",
        url.length,
        -1,
        () => {
          disposeAttachmentChips(attachmentChip(attachment));
        },
        1,
      );
      await measure(
        "static-content-construction",
        url.length,
        -1,
        () => {
          appendStaticMessageContent(document.createElement("div"), message);
        },
        1,
      );
      for (let repeat = 0; repeat < repeats; repeat++) {
        await measure("attachment-construction", url.length, repeat, () => {
          for (let i = 0; i < iterations; i++) {
            const chip = attachmentChip(attachment);
            viewport.append(chip);
            chip.remove();
            disposeAttachmentChips(chip);
          }
        });
        await measure("static-content-construction", url.length, repeat, () => {
          for (let i = 0; i < iterations; i++) {
            const host = document.createElement("div");
            appendStaticMessageContent(host, message);
            viewport.append(host);
            host.remove();
          }
        });
      }
      let cachedImage;
      await measure(
        "image-clone",
        url.length,
        -1,
        () => {
          cachedImage = document.createElement("img");
          cachedImage.src = url;
          cachedImage.cloneNode(true);
        },
        1,
      );
      let blobAttachment;
      await measure(
        "attachment-blob",
        url.length,
        -1,
        () => {
          const blobUrl = countCall("blobConversion", () => {
            const decoded = atob(url.slice(url.indexOf(",") + 1));
            const bytes = new Uint8Array(decoded.length);
            for (let i = 0; i < decoded.length; i++)
              bytes[i] = decoded.charCodeAt(i);
            return URL.createObjectURL(
              new Blob([bytes], { type: "image/png" }),
            );
          });
          blobUrls.push(blobUrl);
          blobAttachment = { ...attachment, dataUrl: blobUrl };
          attachmentChip(blobAttachment);
        },
        1,
      );
      if (typeof Uint8Array.fromBase64 === "function") {
        await measure(
          "attachment-blob-native",
          url.length,
          -1,
          () => {
            const blobUrl = countCall("blobNativeConversion", () =>
              URL.createObjectURL(
                new Blob(
                  [Uint8Array.fromBase64(url.slice(url.indexOf(",") + 1))],
                  { type: "image/png" },
                ),
              ),
            );
            blobUrls.push(blobUrl);
            attachmentChip({ ...attachment, dataUrl: blobUrl });
          },
          1,
        );
      }
      for (let repeat = 0; repeat < repeats; repeat++) {
        await measure("image-direct", url.length, repeat, () => {
          for (let i = 0; i < iterations; i++) {
            const fresh = document.createElement("img");
            fresh.src = url;
          }
        });
        await measure("image-clone", url.length, repeat, () => {
          for (let i = 0; i < iterations; i++) cachedImage.cloneNode(true);
        });
        await measure("attachment-blob", url.length, repeat, () => {
          for (let i = 0; i < iterations; i++) {
            const chip = attachmentChip(blobAttachment);
            viewport.append(chip);
            chip.remove();
          }
        });
      }
    }
    result = {
      ...metadata,
      schemaVersion: 3,
      scenario,
      orderedCache,
      correctness,
      phase2WarmMounted: true,
      nativeBase64: typeof Uint8Array.fromBase64 === "function",
      userAgent: navigator.userAgent,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
      repeats,
      iterations,
      entries,
      limitations: [
        "Synthetic 64x64 PNG tEXt padding matches URL length, not the original image decode/raster workload. Fixture generation is outside measured actions. Image-source scenario pre-decodes its source; ordered-content measures synchronous preparation without waiting for decode or paint.",
        "Cold means first call for this fixture source, not a cold browser/OS image cache. Blob cold total includes conversion and first chip; clone cold includes template source assignment and first clone.",
        "Getter and observer values are instrumented elapsed durations, not sampled CPU time; instrumentation adds overhead.",
        "Mutation action elapsed includes timer yields. Compare getter/observer counts and elapsed separately from construction elapsed.",
        "No scrolling, GPU or physical presentation is measured. This cannot establish that Safari jitter is fixed.",
        "Ordered-content cache is diagnostic only. renderRequest includes renderMarkdown; do not add their times. innerHTML and renderer times are separate attribution within total construction. Ordinary cached HTML is a different row shape, not a matched cache variant.",
        "Ordered-content repetitions rebuild whole rows to isolate preparation cost. The real measured chat retains row elements across viewport unmounts and clears HTML cache on page eviction; this synthetic warm-cache gain does not establish a reachable manual-scroll improvement.",
      ],
    };
  } finally {
    active = null;
    for (const restore of [
      () => preview?.dispose(),
      () => viewport.replaceChildren(),
      () => {
        globalThis.MutationObserver = nativeObserver;
      },
      ...restorers.reverse(),
      ...blobUrls.map((url) => () => URL.revokeObjectURL(url)),
    ]) {
      try {
        restore();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    globalThis.imageSourceBenchmarkRunning = false;
  }
  if (cleanupError) throw cleanupError;
  globalThis.imageSourceBenchmarkResult = result;
  status.textContent =
    "Complete. Results available in window.imageSourceBenchmarkResult.";
  return result;
};
