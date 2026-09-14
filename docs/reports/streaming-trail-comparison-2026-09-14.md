# CSS and overlay streaming trail comparison

The CSS trail is visually accepted, but the current prototype does not show an
overall CPU improvement over the overlay. CSS uses more content-thread CPU and
less Renderer-thread CPU in the measured Firefox workloads. Both keep regular
animation-frame timing. Keeping CSS is a visual and implementation choice, not
a demonstrated performance optimization.

This is a historical comparison. The CSS prototype was not retained in the
demo; its controls and capture commands below apply to the measured revision.
The accepted shared overlay now belongs to `markdown-viewer` through the
optional `streamingTrail` API.

This report covers the smaller built-in fast-long reply. Use the
[shared overlay follow-up](shared-streaming-trail-2026-09-14.md) for the requested
67,760-character complex fixture and the shared-blend experiment.

## Results

These values are medians of three runs per option and workload. CPU percentages
refer to one core, not the whole machine. The content thread includes JavaScript,
style, and layout work. The Renderer thread is CPU work, not GPU utilization.
The combined column is the median of each run's two-thread sum, not total browser
CPU or the sum of the separate medians. Parentheses show the observed range.

| Workload | Option | Content CPU | Renderer CPU | Combined CPU |
| --- | --- | --- | --- | --- |
| Hands-off following | Off | 10.95% (9.23–10.98) | 3.33% (2.87–3.42) | 14.31% (12.10–14.37) |
| Hands-off following | Overlay | 11.91% (9.65–12.14) | 7.47% (6.16–8.27) | 19.38% (15.81–20.41) |
| Hands-off following | CSS | 14.51% (13.93–15.88) | 5.82% (5.34–6.21) | 20.33% (19.27–22.09) |
| Native scrollback | Off | 10.08% (7.79–10.29) | 3.03% (2.41–3.04) | 13.13% (10.20–13.32) |
| Native scrollback | Overlay | 11.68% (11.02–12.40) | 5.29% (4.82–5.46) | 16.97% (15.84–17.86) |
| Native scrollback | CSS | 15.07% (10.97–15.47) | 4.32% (3.50–4.47) | 19.40% (14.47–19.93) |

During hands-off following, the CSS content-thread median is 21.9% higher than
the overlay median. Its Renderer-thread median is 22.1% lower. The combined
median is 4.9% higher, but the ranges overlap. Three short runs do not establish
a stable net difference of that size.

All 18 runs record zero frame intervals above 25 ms. The maximum interval across
all runs is 17.66 ms at 60 Hz. Hands-off runs record 286–301 moving frames each,
with scroll position advancing from 12,711 to 13,963 px. Their programmatic scroll
writes are expected autoscroll, not evidence of unwanted correction.

Scrollback runs record 82–90 moving frames, four scroll-end events, and zero
programmatic scroll writes each. Every run reaches a final scroll height of
14,774 px. Intermediate heights vary slightly with token timing. Scrolling back
hides part of the newest text, so its painting cost differs from hands-off use.

## Where the work moves

CSS avoids the overlay's range measurements and rectangle positioning. However,
this prototype still uses JavaScript to find new text, split text nodes, restore
spans after renderer updates, preserve fade age, and remove expired spans.
The browser animates the backgrounds. This is not a JavaScript-free effect.

The profiles show more style work in CSS mode. These marker totals are nested
wall-clock measurements, not independent CPU costs, and must not be added to
the CPU table above. Values are medians of three runs.

| Hands-off marker or sample measure | Off | Overlay | CSS |
| --- | --- | --- | --- |
| Style marker duration | 77.91 ms | 87.97 ms | 180.54 ms |
| Non-interruptible reflow marker duration | 31.27 ms | 39.32 ms | 42.29 ms |
| Samples attributed to trail functions | 0 | 28 | 51 |

Trail attribution credits the nearest JavaScript function, including native
work beneath it. It is not pure JavaScript CPU time. Captured CSS functions
include text scanning, overlap matching, and span painting. The source and
profiles support a cost shift toward text/DOM and style processing, but they do
not isolate the exact contribution of each operation.

The overlay keeps its decorations outside the renderer's DOM updates. Its
geometry measurements and opacity layers impose different costs, and blending
can tint syntax colors. CSS paints actual inline backgrounds and follows font
geometry directly. The current CSS prototype passes the visual regressions,
including the cursor-height correction, and the user accepts its appearance.

If CSS is retained, a possible next investigation is renderer-owned chunk
identity, which can avoid some external span-restoration work. Any improvement
from that integration remains unmeasured. Neither implementation changed during
this comparison, and no runtime or dependency change is part of this report.

## Capture conditions and reproduction

The September 14, 2026 captures use the uncommitted prototypes above `c5fa175`,
after the CSS cursor-height correction. All runs use installed Firefox 155.0.1,
fresh temporary profiles, closed DevTools, and live profile collection. The
LU28R55 is 1,920×1,080 logical pixels at 2× and 60 Hz. Each browser content area
is 1,900×965. The workload uses the built-in fast long reply, including tables,
code, paragraphs, and lists, through the existing Vite development server.

Both enabled modes use a 1,200 ms fade. Each workload runs options in this order:
off, overlay, CSS, CSS, off, overlay, overlay, CSS, off. No other benchmarks run
during capture. The user's existing browser and server remain open. Profile
startup is cold, followed by two seconds of page warmup and two seconds after
starting the reply. Token delays are randomized by the existing simulator.

Use this command for hands-off following. Despite the runner's manual-mode
prompt, do not scroll: the runtime's autoscroll supplies the measured movement.
Change `trail=css-long` to `trail=long` or `trail=off` for the other options.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url='http://127.0.0.1:5173/demos/streaming/?trail=css-long&fast-long' \
  --layout=none --setup=scripts/firefox-profile/fixtures/streaming-chat.js \
  --warmup-ms=2000 --manual-seconds=6 --live \
  --output=browser-artifacts/streaming-trail/css-comparison-follow
```

For native scrollback, replace `--manual-seconds=6` with
`--down=2 --up=2 --ticks=30 --delta=12`. Change the output directory to
`browser-artifacts/streaming-trail/css-comparison-final`. Those windows last
5.21–5.40 seconds. Hands-off windows last approximately 6.01 seconds and include
the end of generation. The scripted native gestures have no trackpad momentum.

These local-only IDs preserve all measured captures. Raw profiles, screenshots,
and metadata remain under the ignored output directories above.

| Workload | Option | Run IDs |
| --- | --- | --- |
| Hands-off | Off | `run-L0Ztb4`, `run-6OiuH8`, `run-IDvqQk` |
| Hands-off | Overlay | `run-v3Os5Q`, `run-nFSUGg`, `run-vgk9uO` |
| Hands-off | CSS | `run-QamZ5o`, `run-2Exhyl`, `run-Y4oslS` |
| Scrollback | Off | `run-bgaosb`, `run-rH9nsz`, `run-D9YZp8` |
| Scrollback | Overlay | `run-6FrgHq`, `run-R6FZfq`, `run-NRG9hQ` |
| Scrollback | CSS | `run-patJkm`, `run-6EUirV`, `run-u1fUwF` |

Use `scripts/firefox-profile/cpu.mjs RUN_DIRECTORY` for thread CPU and
`scripts/firefox-profile/attribute.mjs RUN_DIRECTORY --filter=streaming-trail`
for trail attribution, both through Node.js. Each run's `summary.json` contains
frame timing and marker totals. All captures complete, and the runner removes
all 18 temporary browser profiles after closing its owned browsers.

These results do not measure Safari or Chromium CPU, battery use, GPU utilization,
or physical display presentation. Short synthetic runs with randomized token
timing do not establish production cost. The
[earlier prototype report](streaming-trail-prototype-2026-09-14.md) preserves
the overlay's earlier measurements and native Safari visual evidence.
