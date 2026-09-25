# Streaming cursor style invalidation

This investigation starts from `bcfdb65`, after the image-preview scan
optimization. It targets Chrome's remaining style-recalculation cost during
the complex streaming chat fixture. Firefox is profiled first, and the
candidate is checked in all three installed browsers on the external display.

## Cause and candidate

The renderer's two cursor-spacing selectors use
`:has(+ .cursor:last-child)` to remove the bottom margin of the block before a
bare cursor and its last child. Chrome's invalidation trace associates these
rules with subtree invalidations during Markdown morphs, image-preview class
changes, and trail updates. Unrelated changes can therefore restyle much of
the completed response.

The candidate replaces those selectors with `data-cursor-block`, managed by
the renderer immediately after its existing morph. It marks only the element
before a trailing cursor that is a direct child of the Markdown container.
The marker is removed when the cursor moves, streaming finishes, the viewer
resets, rendering fails, or the viewer is destroyed. DOM relationship checks
don't read layout. An unchanged marker isn't written again, but a marker
removed by morphing is restored even when the block's identity is unchanged.

The patch is applied to the pinned `markdown-viewer` distribution through
pnpm's recorded patch hash. It preserves cursor spacing without changing the
virtual-list geometry reads, which remain necessary for native anchoring and
scroll-range changes. See the [patch maintenance notes](../../patches/README.md).

## Diagnostic controls

A fresh unmodified Firefox capture, `firefox-timing-UUyzPP`, completed the
full stream with 759 moving intervals and a 17.24 ms moving p95. Chrome
diagnostic `M7bFRZ` then recorded 3,419 ms of inclusive `UpdateLayoutTree`
time. Its style passes touched 9,225 elements at p95, and the instrumented
`viewportState` calls consumed 1,001 ms.

Full-workload invalidation capture `pfjAGE` overflowed Chrome's trace buffer
and lost its end marker. It is excluded. Invalidation tracing is now explicit
through `--trace-invalidations`, restricted to installed Chrome diagnostic
mode. Reduced captures use 12 sections, 40 history turns, a 4-second stream,
and an 8-second measurement window. They locate causes and are not timing
benchmarks.

| Reduced diagnostic control | Local run ID | Elements per style pass, p95 | Decision |
| --- | --- | ---: | --- |
| Original selectors | `oait7F` | 1,988 | Baseline attribution. |
| Narrow generated-files selector | `l17rM8` | 1,999 | Rejected; large restyles remain. |
| Remove local inherited image-gap rule | `x7jK36` | 2,103 | Rejected; large restyles remain. |
| Move the last-child test outside the renderer's `:has()` | `wp7R4U` | 2,186 | Rejected; large restyles remain. |
| Remove both renderer cursor-spacing rules | `h0egA7` | 144 | Confirms their contribution, but changes spacing and is not retained. |

The spacing-preserving marker candidate, full-workload diagnostic `pQZvIx`,
recorded 475 ms of `UpdateLayoutTree` time and 144 elements per style pass at
p95. `viewportState` self time fell to 211 ms across 2,541 calls, compared
with 1,001 ms across 2,465 baseline calls. This is consistent with cheaper
style flushes at existing geometry reads, rather than fewer required reads.
These diagnostic values include instrumentation and are not CPU-utilization
measurements.

## Comparison conditions

Timing trials use 48 sections, 160 history turns, the long trail, a 12-second
stream, and a 20-second capture window. The expected reply contains 44,230
characters in 461 chunks, with input hash
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
DevTools remains closed and every trial uses a fresh automation profile.

The LU28R55 display has 1920 × 1080 logical pixels at 2x scaling and 60 Hz.
Windows are 1900 × 1049 at (1450, 31). Installed builds are Firefox 156.0.1,
Chrome 153.0.8010.53, and Safari 27.0 (22625.1.29.11.27). Safari retains the
same Inspector-backed MCP transport. Results are compared within each
browser, with its matching viewport geometry.

The order is `B, C, C, B, B, C` in each browser, starting with Firefox, then
Chrome, then Safari. Only the registered renderer patch differs in production
code. The lockfile and workspace configuration are switched together and a
frozen install applies the selected version before each capture. Test suites
do not run during timing captures.

## Timing results

All 18 trials complete the expected stream and record movement. All nine
pairs pass the validity and environment comparison checks. Values are
medians of three trials per variant, with observed ranges in
parentheses. Frame intervals refer to movement reported by the page, not
physical presentation on the monitor.

| Browser / metric | Baseline | Candidate |
| --- | ---: | ---: |
| Firefox moving p95 | 17.20 ms (17.18–17.20) | 17.16 ms (17.14–17.18) |
| Firefox moving intervals >25 ms | 2 (1–2) | 2 (2–3) |
| Firefox content-thread CPU | 3,967 ms (3,860–4,148) | 4,048 ms (3,881–4,240) |
| Chrome moving p95 | 33.3 ms (32.9–33.3) | 17.5 ms (17.4–17.5) |
| Chrome moving intervals >25 ms | 54 (42–55) | 2 (2–13) |
| Chrome main-thread task time | 7,660 ms (7,367–8,048) | 4,785 ms (4,549–5,661) |
| Chrome style-recalculation time | 3,380 ms (3,359–3,511) | 505 ms (455–520) |
| Chrome style-pass element p95 | 9,212 (9,192–9,235) | 145 (144–145) |
| Safari moving p95 | 20 ms (20–20) | 20 ms (19–21) |
| Safari moving intervals >25 ms | 4 (4–6) | 4 (4–7) |

Chrome's median task time falls 37.5%, and style time falls 85.1%. Every
candidate trial is below every baseline trial for both measures. The native
sampled wall time attributed to `get scrollTop` also falls from roughly
1.4–1.6 seconds to roughly 0.15–0.17 seconds. The patch addresses the work
flushed by that getter without changing its semantics or caching its value.

Firefox's frame timings are effectively unchanged. Its CPU median is 2.1%
higher, with overlapping ranges, so this sample establishes neither a CPU
gain nor a reliable regression.

Safari's median frame timing and long-interval count are unchanged. This
transport doesn't provide native Safari CPU attribution. The shared patch
is retained for the repeated Chrome reduction with preserved spacing and
no demonstrated timing regression in Firefox or Safari.

The Chrome candidate still records maximum moving intervals of 83, 100, and
217 ms, compared with 51, 83, and 83 ms in the baseline. The 217 ms interval
coincides with a roughly 220 ms microtask checkpoint near stream completion.
It remains in the results. These trials demonstrate lower sustained streaming
cost and fewer long intervals; they do not establish an improvement in the
worst completion stall or jitter-free physical scrolling. That tail needs a
separate investigation with focused attribution.

| Browser | Baseline run IDs | Candidate run IDs |
| --- | --- | --- |
| Firefox | `jVxeuR`, `bBb3C0`, `yr1nPQ` | `xUORaa`, `8C6LKf`, `0QFL1Y` |
| Chrome | `VZB8PZ`, `KD2Xdp`, `bPx2HR` | `1NK4OM`, `iYMViQ`, `GahRgH` |
| Safari | `Su9ZYh`, `EMhTXh`, `0GkBpI` | `gZFXeE`, `rmBbIK`, `IPkhLL` |

These IDs have the local `<browser>-timing-` prefix. Diagnostic IDs above
have the `chrome-diagnostic-` prefix unless Firefox is named explicitly.

## Native input and correctness

Three additional candidate captures use native macOS scrollback input. All
complete the response and pass the input, focus, geometry, and movement
checks. They validate native operation; they have no paired scrollback
baseline and don't measure an improvement over the previous renderer.

| Browser / local run ID | Wheel events | Scroll-end events | Moving intervals |
| --- | ---: | ---: | ---: |
| Firefox `4RWqFG` | 895 | 17 | 862 |
| Chrome `XMiISq` | 706 | 13 | 656 |
| Safari `SOTR2E` | 718 | 13 | 721 |

Firefox pages from loaded messages 133–160/160 to 109–162/162. Chrome and
Safari finish at 133–162/162 and don't cross an older-page boundary, so those
runs don't establish paging coverage. Scripted native input doesn't include
real trackpad momentum. Physical jitter remains a manual validation task.

The cursor regressions check real computed margins through edits, transitions
between bare and inline cursors, reset, nested math, and stream completion in
Firefox, Chromium, and WebKit. Image spacing and footer height also pass in
all three engines, including the touch footer cases.

The production build and static checks pass. The unit suite passes, and all
107 portable profiler checks pass. The broader browser checks cover standalone
and paged streaming consumers, streaming height with and without a cursor,
trail coverage and pixels, profiler capture, and generated-file persistence
and downloads. These pass in Firefox, Chromium, and WebKit.

All captures remove their raw inputs after analysis. Final cleanup also
removes generated regression screenshots and the shared compiler and Vite
caches. The retained local summaries and reproduction records occupy about
11.8 MiB across both optimization rounds and the earlier verification. No raw
capture files remain. The final process audit finds only the pre-existing
user browsers and development servers; the owned profiling and test processes
have closed.

## Reproduce

Use the profiler and patch from this report's commit. For the baseline, create
a separate worktree at that same revision and restore `pnpm-lock.yaml` and
`pnpm-workspace.yaml` from `bcfdb65` there. Install dependencies in both
worktrees with `pnpm install --frozen-lockfile`. This keeps the same profiler
while enabling or disabling only the renderer patch.

Run each installed browser sequentially on the same display:

```sh
pnpm run profile:chat -- --browser=firefox --mode=timing \
  --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --mode=timing \
  --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=safari --mode=timing \
  --display=LU28R55 --refresh-hz=60
```

Use the interleaved order above. Compare validity, workload hash, browser
build, transport, display, and window geometry before interpreting results.
Every capture saves compact summaries and source replay metadata, including
integration styles, dependency patches, and pnpm configuration. Raw captures
are removed after analysis. Native invalidation examples retain bounded
stacks and selectors, so a later question can be answered by a new capture.
