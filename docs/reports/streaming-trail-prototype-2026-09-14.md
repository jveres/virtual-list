# Streaming trail prototype

The opacity-layer prototype passes the wrapped-text and fade tests in Firefox,
Chromium, WebKit, and installed Safari. It replaces the CSS Highlight painting
path that produced detached bands and stale fades in Safari. This report covers
uncommitted demo changes above `c5fa175`, not a released API.

This is a historical prototype record. The accepted shared overlay now belongs
to `markdown-viewer` as the optional `streamingTrail` feature. Prototype-only
controls were removed; maintained browser regressions target the public API.

## Rendering and ownership

The effect paints small rectangles in a separate layer beside the Markdown
container. The Markdown renderer does not own or replace this layer. The browser
animates each group's opacity, so the fade does not need a JavaScript frame loop.

- Read at most 2,048 recent UTF-16 units through 512 DOM nodes.
- Keep at most eight fade groups and 128 painted rectangles.
- Batch geometry reads before style writes when content or layout changes.
- Skip style writes when a group's geometry stays unchanged.
- Keep each group's age when a Markdown update replaces text nodes.
- Reposition after resize and horizontal scrolling within code blocks or tables.
- Disable the effect for reduced motion and clear it when the row unmounts.

The layer moves with its message during viewport scrolling. It adds no viewport
scroll listener. The effect does use bounded `Range.getClientRects()` calls when
text changes, so it is not a zero-CPU feature. The disabled option creates no
trail observers or layers. The virtual-list runtime and dependency pin remain
unchanged.

Darken or lighten blending preserves dark or light text over the rectangles.
Colored glyphs can also change tint. This differs from a true background
highlight. The prototype uses the host's `color-scheme` to select the blend mode.
Arbitrary scaled or rotated hosts are not part of this verification.

## Browser evidence

The reusable regression checks paragraphs, lists, headings, quotes, inline
formatting, code, tables, resize, dark mode, and horizontal code scrolling. It
also checks fade age after DOM replacement, final cleanup, reduced motion,
resource bounds, and the live demo toggle. An idle running fade records zero
range measurements over a 200 ms observation window.

Firefox 153, Chromium 151, and WebKit 26.5 pass this regression. Native Safari
26.6.2 uses a separate WebDriver session because the bundled WebKit build did not
reproduce Safari's stale fade. The Safari fixture uses 600 px wide text at
24 px with a 48 px line height and 2× scaling.

The Safari test reads screenshot pixels, not only computed animation values.
The last line changes from approximately RGB `(241, 193, 255)` through lighter
colors to white. The line gap stays RGB `(255, 255, 255)` throughout the fade.
Assertions require intermediate colors, no backwards flash, and full cleanup.
The same diagnostic can reproduce the old failure with one native highlight,
without the prototype's tracking or DOM observation.

Run the browser regression against a local demo server:

```sh
BROWSER_MATRIX_URL=http://127.0.0.1:5173 \
  pnpm run test:regression -- --group=runtime --match=streaming-trail
```

For native Safari, start `safaridriver --port 4447` in a separate terminal.
Then run `node scripts/regressions/runtime/streaming-trail-safari-probe.mjs`.
The script closes its automation session. Stop the driver afterward.
The old native-highlight failure is isolated by `streaming-trail-wrap-probe.mjs`.
The Safari probe now checks only the accepted renderer option. Normal browser
tabs and settings are not modified.

## Firefox cost check

Six sequential captures use installed Firefox 155.0.1 with fresh profiles and
closed DevTools. The LU28R55 display uses 1,920×1,080 logical pixels at 2× and
60 Hz. The browser content area is 1,900×965. Every run uses the fast reply and
four native gestures, with two downward and two upward bursts.

The table lists average sampled CPU as a percentage of one core. Renderer CPU
is the captured Renderer thread, not GPU utilization. Each window lasts about
5.3–5.4 seconds. Raw run IDs identify local-only captures.

| Variant | Local run ID | Content CPU | Renderer CPU | Maximum frame interval |
| --- | --- | --- | --- | --- |
| Old CSS Highlights | `run-vg1oXG` | 16.39% | 3.72% | 17.62 ms |
| Initial opacity layer | `run-tblnVQ` | 13.44% | 5.28% | 17.66 ms |
| Disabled, first run | `run-c5K3c0` | 7.50% | 2.39% | 17.58 ms |
| Cached geometry, first run | `run-jI2HwV` | 10.64% | 4.58% | 17.46 ms |
| Disabled, repeat | `run-vTG1yQ` | 10.19% | 2.97% | 17.52 ms |
| Cached geometry, repeat | `run-Hgt5mx` | 11.28% | 4.92% | 17.60 ms |

Every run records actual scrolling, four scroll-end events, continued reply
growth, zero programmatic `scrollTop` writes, and zero long frame intervals.
The final scroll range reaches 14,774 px in each run. The first cached run's
second gesture ends at a slightly later point in text generation.

The replacement adds measurable work compared with disabling the effect.
The observed content CPU is lower than the old Highlight prototype, but Renderer
CPU is higher. These short captures do not establish a general performance gain
or a zero-cost feature. Token timing and browser startup work vary between runs.
Regular animation callbacks do not prove smooth physical display presentation.

Use this command for the enabled workload. Change `trail=long` to `trail=off`
for the disabled comparison:

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url='http://127.0.0.1:5173/demos/streaming/?trail=long&fast-long' \
  --layout=none --setup=scripts/firefox-profile/fixtures/streaming-chat.js \
  --warmup-ms=2000 --down=2 --up=2 --ticks=30 --delta=12 --live \
  --output=browser-artifacts/streaming-trail/firefox-after
```

The earlier Highlight baseline is under `firefox-before` in the same local
artifact directory. Use `scripts/firefox-profile/cpu.mjs` for CPU attribution.
All raw captures and screenshots remain local under ignored `browser-artifacts`.

## Acceptance boundary

The effect remains optional and disabled by default. The implementation is a
demo-side renderer experiment, not a new virtual-list concern or a published
markdown-viewer option. Visual acceptance and a decision about the measured
cost remain necessary before promoting it into markdown-viewer.
