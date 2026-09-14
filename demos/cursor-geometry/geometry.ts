import {
  createMarkdownViewer,
  initMarkdownViewer,
  type MarkdownViewerHandle,
} from "markdown-viewer";
import "markdown-viewer/styles.css";
import "./geometry.css";

const samples = [
  { font: "Arial, sans-serif", size: 14, leading: 1.5, marker: "" },
  { font: "system-ui, sans-serif", size: 18, leading: 1.5, marker: "" },
  { font: "Georgia, serif", size: 22, leading: 1.5, marker: "" },
  { font: '"Times New Roman", serif', size: 26, leading: 1.8, marker: "*" },
  { font: "Menlo, monospace", size: 30, leading: 1.5, marker: "" },
  { font: "Verdana, sans-serif", size: 34, leading: 1.3, marker: "**" },
];

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing geometry control: ${selector}`);
  return found;
}

const host = element<HTMLDivElement>("#samples");
const hold = element<HTMLInputElement>("#hold");
const glow = element<HTMLInputElement>("#glow");
const rounded = element<HTMLInputElement>("#rounded");
const theme = element<HTMLSelectElement>("#theme");
const replay = element<HTMLButtonElement>("#replay");
const status = element<HTMLParagraphElement>("#status");
element<HTMLParagraphElement>("#renderer-build").textContent = import.meta.env
  .VITE_RENDERER_LOCAL
  ? "LOCAL RENDERER PREVIEW"
  : "PINNED RELEASE (see package.json)";
let viewers: MarkdownViewerHandle[] = [];
let generation = 0;

function destroyViewers(): void {
  for (const viewer of viewers) viewer.destroy();
  viewers = [];
}

async function renderSamples(): Promise<void> {
  const current = ++generation;
  document.documentElement.dataset.held = String(hold.checked);
  destroyViewers();
  host.replaceChildren();

  for (const sample of samples) {
    const row = document.createElement("section");
    row.className = "sample";
    row.style.setProperty("--sample-font", sample.font);
    row.style.setProperty("--sample-size", `${sample.size}px`);
    row.style.setProperty("--sample-leading", String(sample.leading));
    const label = document.createElement("p");
    label.className = "sample-label";
    const style =
      sample.marker === "**"
        ? "bold tail"
        : sample.marker
          ? "italic tail"
          : "regular";
    label.textContent = `${sample.font.split(",")[0]} · ${sample.size}px · line-height ${sample.leading} · ${style}`;
    const mount = document.createElement("div");
    mount.className = "sample-host";
    row.append(label, mount);
    host.append(row);
    const prefix = "Markdown with ";
    const viewer = createMarkdownViewer(mount, {
      text: prefix,
      isStreaming: true,
      streamingTrail: { durationMs: 1800 },
      throttleMs: 0,
      focusOnStreamingStart: false,
      unfocusedCursorStyle: "block",
    });
    viewers.push(viewer);
    viewer.update({
      text: `${prefix}${sample.marker}fresh glyphs${sample.marker}`,
    });
  }

  // Let the real renderer observe the append and paint its Range rectangles.
  // Pause its animations, rather than fabricating highlight/cursor boxes.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (current !== generation) return;
  if (hold.checked) {
    for (const group of host.querySelectorAll("[data-trail-group]")) {
      for (const animation of group.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  }
  status.textContent = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "Reduced motion is enabled: the renderer disables the trail. Disable it to inspect the highlight."
    : hold.checked
      ? "Held at the start of the fade. Inspect glyph coverage and cursor alignment with glow off."
      : "Replaying a 1.8-second fade; the cursor then blinks. Replay to repeat.";
}

async function start(): Promise<void> {
  await initMarkdownViewer();
  const render = (): void => {
    void renderSamples().catch((error: unknown) => {
      status.textContent = `Could not render samples: ${String(error)}`;
    });
  };
  replay.addEventListener("click", render);
  hold.addEventListener("change", render);
  theme.addEventListener("change", () => {
    document.documentElement.dataset.theme = theme.value;
    render();
  });
  glow.addEventListener("change", () => {
    document.documentElement.dataset.glow = String(glow.checked);
  });
  rounded.addEventListener("change", () => {
    document.documentElement.dataset.rounded = String(rounded.checked);
  });
  // The renderer clears trails when a tab is hidden. Recreate this static
  // inspection sample when the user returns to it.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  window.addEventListener("pagehide", () => {
    generation++;
    destroyViewers();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) render();
  });
  render();
}

void start().catch((error: unknown) => {
  status.textContent = `Could not initialize renderer: ${String(error)}`;
});
