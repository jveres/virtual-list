# Safari 27 manual-scroll investigation

Release status, September 16, 2026: the user approved preparing `v0.2.0`
with the retained scrolling improvement. The latest external-display repeat
is nearly perfect, but occasional shifts remain. The built-in display remains
smooth. This is an improvement, not a complete fix.

The runtime retains the canvas layer and adds `transform-style: preserve-3d`
only in WebKit after the Firefox comparison below. Removing the canvas layer
makes jitter worse and is reverted. The earlier user confirmation below does
not establish a complete fix. Historical release holds below describe earlier
stages of this investigation, not the current release decision.

The initial mounting-order change removes visible shifts in the user's first
repeat, with canvas and per-row compositing hints retained. Page timing alone
does not prove correct physical presentation. The renewed investigation must
match the user's small-card masonry configuration and longer chat history.

## Conditions and method

This investigation starts from `03cb677`, with the requested chat footer and
composer spacing changes still uncommitted. The affected browser is Safari
27.0, build `22625.1.29.11.27`, on macOS 27.0, build `26A428`. The user reports
the issue during ordinary manual scrolling in idle chat and gallery, on both
displays, but not in Safari 26.

The Safari-only regression is an explicit exception to the
[Firefox-first workflow](../firefox-profiling.md). Captures use normal Safari
windows, native macOS wheel input, closed DevTools, and a temporary local
server. The runner closes its own window and server after each capture. It
does not close the user's existing tabs or change Safari preferences.

The external display is a LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz. Most gallery captures use a 1920 × 997 browser viewport and a
951-pixel scroll container. The canvas-layer-only capture is 20 pixels narrower
and is not a strictly matched comparison.

The gallery workload starts with a 5,114-pixel scroll range. It makes three
1,080-pixel downward gestures and three upward gestures, with 1,200 ms pauses.
Each gesture uses 90 native 12-pixel input steps. This workload crosses virtual
row boundaries but does not reach the next page. Synthetic input does not
reproduce real trackpad momentum exactly.

The animation-frame sampler reads a cached scroll position, not DOM geometry.
A separate diagnostic reads row coordinates immediately before and after DOM
insertion or removal. Those diagnostic reads can affect rendering costs, so its
timing is not an uninstrumented baseline.

## Measurements

These single captures describe observed behavior, not a demonstrated speedup.
Run IDs identify local artifacts. CPU values cover the identified WebContent
process, which Safari can share with other tabs. They exclude total GPU cost.

| Configuration | Local run ID | Scroll events | Maximum callback interval | Intervals above 25 ms | WebContent CPU / elapsed time |
| --- | --- | ---: | ---: | ---: | --- |
| Original runtime | `sRZf3M` | 528 | 60 ms | 6 | 3.05 s / 18.887 s |
| Original runtime, boundary geometry reads | `4qH8l1` | 537 | 25 ms | 0 | 2.59 s / 18.868 s |
| All initial gallery items mounted | `OPx9TY` | 529 | 23 ms | 0 | 2.39 s / 18.890 s |
| Canvas compositing candidate, narrower viewport | `2y3OU9` | 529 | 24 ms | 0 | 2.55 s / 18.880 s |
| Canvas plus per-row compositing candidate | `prXzYD` | 527 | 23 ms | 0 | 2.59 s / 18.797 s |
| Row-only isolation control | `OUO91P` | 538 | 28 ms | 1 | 2.79 s / 18.662 s |
| Canvas-only isolation control, matched viewport | `wHFV80` | 539 | 27 ms | 1 | 2.75 s / 18.746 s |
| Canvas plus per-row repeat, before mount-order fix | `TyERfC` | 538 | 18 ms | 0 | 2.86 s / 18.820 s |
| Final runtime with boundary geometry reads | `5nyEcQ` | 536 | 27 ms | 1 | 2.75 s / 18.887 s |

Every listed capture records six scroll-end events, no application
`scrollTop` assignments, and no page errors. The 95th-percentile callback
interval is 17 ms in every capture. Recorded scroll height stays constant
through the six gestures.

The boundary diagnostic records 120 snapshots across 60 mount/unmount
operations. Surviving rows retain exactly the same document-relative vertical
coordinate and height. There is no measured layout shift at these boundaries.
This result does not exclude a stale or misplaced painted layer.

An idle chat capture with the canvas candidate (`7HDvzr`) records 545 scroll
events, six scroll-end events, zero application scroll writes, and a maximum
callback interval of 21 ms. Its synthetic momentum workload differs from the
gallery workload. An interrupted matching baseline is invalid evidence.

## Candidate status

User observations remain necessary because the page metrics do not capture
the reported visual defect. The experiments establish these limits:

- Promoting the canvas with `translateZ(0)` improves the user's experience,
  but visible shifts remain.
- Replacing row transforms with `top` offsets does not remove the shifts.
  That experiment is reverted.
- Keeping departing rows mounted until scrolling settles does not remove
  shifts during active scrolling. That experiment is reverted.
- Adding `will-change: transform` to mounted rows, alongside the canvas
  candidate, substantially improves scrolling according to the user. Small
  shifts remain until the mounting-order fix. Bounded mounting remains active.
- Mounting all initial gallery items produces regular callback timing, but
  does not have user confirmation of smooth physical presentation. It is not
  a production solution because it removes virtualization for that workload.

The final row hint preserves explicit inline animation hints and their CSS
priority on direct cards. It does not replace the host's transform. Compositing
still requests additional layers, bounded by mounted slots. GPU memory is not
measured, and WebContent CPU alone does not establish total rendering cost.

## Mounting-order correction

Previously, `mountRow()` attached a new slot and called the host's `onMount`
before `reconcileWindow()` applied the slot's committed offset. A host that
forces layout inside `onMount` therefore observes the wrong initial position.
This happens for measured, declared-height, and explicitly positioned rows.

Three regression tests fail before the fix: connected rows report no placement
transform during their mount callback. The fix calls `placeRow()` before
attaching the slot, so the callback observes its committed position. The tests
cover initial mounting, scrolling to new rows, and returning to earlier rows.
No scroll offsets, anchoring policy, or scroll scheduling change.

After this correction, the user reports no shifts. This supports retaining the
combined change, but does not establish the exact upstream compositor race.
Six additional tests cover preserving direct-card animation hints and priority.

## Safari changes relevant to the investigation

Apple's [Safari 27 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes)
enable native scroll anchoring and list a fix for transient wrong scroll
positions during anchoring (`173456210`). They also describe compositing and
scrolling fixes, including `173197381` and `171024685`. These entries establish
changes in the affected area, not a match for this particular regression.

The runtime already sets `overflow-anchor: none` on its canvas. Gallery also
disables anchoring on the scroll container. A missing canvas opt-out is
therefore not the demonstrated cause.

WebKit [commit 80eaeca](https://github.com/WebKit/WebKit/commit/80eaeca1f565e58a3df57b5d6b2a77cb40446dea)
addresses a macOS race between scrolling-thread layer positions and backing
store updates during programmatic scrolling or anchoring. It adjusts Core
Animation transaction flushing. That failure mechanism is relevant to the
hypothesis, but these captures show no application scroll writes during the
ordinary gallery gestures. The upstream fix is not proof of the same bug.

## Verification and limitations

The final runtime passes `pnpm run check` and all 1,044 unit tests
in 46 files. The WebKit gallery paging regression passes masonry at DPR 1, 2,
and 1.25, and justified rows at DPR 1 and 2. Those tests cover bounded retention,
resize anchors, and paging correctness, not physical scroll presentation.

Chromium and WebKit dynamic-resize checks pass again after the mounting-order
fix. The separate WebKit gallery-resize check passes during the earlier
deferred-removal diagnostic. Playwright Firefox fails a separate
startup smoke test before page content loads, while Chromium and WebKit start.
That failure is not evidence of a runtime regression.

The installed command-line tools do not provide `xctrace`. No compositor trace
or physical-presentation measurement is available from these captures. No
screen recording is used as evidence. Interrupted, stationary, wrong-display,
and CPU-contaminated captures are excluded from performance conclusions.

## Reusable tooling and follow-up

The [native Safari diagnostic](../../scripts/firefox-profile/safari-scroll.mjs)
retains the native-input and boundary-measurement workflow. It owns a temporary
local server and one normal Safari window. It requires macOS Accessibility and
Safari's **Allow JavaScript from Apple Events** setting, without changing either.
Run it from the repository root:

```sh
node scripts/firefox-profile/safari-scroll.mjs
GEOMETRY=1 node scripts/firefox-profile/safari-scroll.mjs
DEMO=streaming MANUAL_SECONDS=30 node scripts/firefox-profile/safari-scroll.mjs
```

The first command records lightweight timing. The second adds synchronous
boundary reads, which can perturb timing. The third records real manual input.
The runner has no screen-recording path and does not modify runtime source.

The final native Safari repeat loses foreground to another application and
aborts safely (`hh79kc`). It is not performance evidence.

The subsequent boundary diagnostic completes (`5nyEcQ`). Its 60 operations
again show zero coordinate or height changes for surviving rows, with six
scroll-end events and no application scroll writes. The diagnostic records one
27 ms callback interval. Its synchronous geometry reads and the removed
exploratory function instrumentation prevent a strict timing comparison with
earlier lightweight captures.

## Firefox comparison of the final change

Four installed-Firefox 155.0.1 captures complete on the LU28R55 at 2× scaling
and 60 Hz. Both revisions use a 1900 × 965 browser viewport at `(1450, 31)`.
Every run uses a fresh profile, closed DevTools, three downward gestures, and
three upward gestures. Each gesture sends 90 native 12-pixel steps with a
1,200 ms settle pause. No Playwright wheel events are used.

The baseline serves `src/virtual-list.ts` from `03cb677`. Everything else,
including dependencies and the pending demo spacing changes, matches the final
working tree. The
[revision server](../../scripts/firefox-profile/runtime-revision-server.mjs)
provides this one-file comparison without changing the checkout:

```sh
node scripts/firefox-profile/runtime-revision-server.mjs 03cb677 4194
node scripts/firefox-profile/runtime-revision-server.mjs working 4193
```

Run each server in its own terminal. Capture gallery against each port with:

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4194/demos/gallery/ --layout=masonry \
  --down=3 --up=3 --ticks=90 --delta=12 --settle-ms=1200 \
  --warmup-ms=2000 --live --output=browser-artifacts/firefox-safari27-check
```

For chat, change the path to `/demos/streaming/`, use `--layout=none`, and add
`--setup=scripts/firefox-profile/fixtures/idle-chat-scroll.js`. The fixture
starts at 1,000 pixels, away from the prompt pin and paging boundary. Repeat
against port 4193 for the final runtime. Stop both servers after the captures.

These are single baseline/final pairs, not repeated speedup measurements.
CPU values are sampled thread CPU milliseconds during the measurement window.
The Renderer column measures a CPU thread in the GPU process, not GPU hardware
utilization or GPU memory.

| Workload | Revision / local run ID | Window | Scroll events | Maximum frame interval | Content main CPU | Renderer CPU | Maximum scroll-event handler |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Gallery | Baseline / `FQRzoD` | 18.50 s | 534 | 17.64 ms | 301.49 ms | 317.61 ms | 3.337 ms |
| Gallery | Final / `GhQcfs` | 18.48 s | 530 | 17.66 ms | 300.75 ms | 292.60 ms | 2.062 ms |
| Idle chat | Baseline / `gVcskw` | 18.41 s | 529 | 17.64 ms | 349.41 ms | 308.94 ms | 1.635 ms |
| Idle chat | Final / `C7r5vn` | 18.37 s | 536 | 17.66 ms | 339.81 ms | 307.16 ms | 1.635 ms |

All four runs record six scroll-end events, zero intervals above 25 ms, and
zero application `scrollTop` assignments. Gallery loads its next page on the
third downward gesture in both revisions, increasing retained photos from
120 to 240. Chat retains a constant 13,178-pixel scroll height. Every gesture
moves by the expected 1,080 pixels.

The final gallery records a 10.02 ms timer callback during page completion,
outside a scroll-event handler, without a missed 25 ms frame budget. The
final chat has no selected callback marker above 8 ms. Runtime-attributed
samples remain between 0.16% and 0.23% across the four captures. These include
native descendants of JavaScript frames, not pure JavaScript CPU.

No frame-timing or average CPU regression appears in these captures. Peak
100 ms CPU bins vary: chat Renderer reaches 19.78% of one core in the final
run versus 8.97% in the baseline, despite almost equal total Renderer CPU.
This comparison does not prove a CPU speedup or uniformly lower peak cost.
It also does not measure physical display presentation.

The first launch (`zOQZ3Y`) fails before the automation connection opens and
is excluded. Temporary application-data directories then allow all four runs
to complete without accessing the regular Firefox profile. The runner removes
every temporary browser profile, including the failed run.

## Cleanup

The user requests removal of this investigation's raw data and scratch files.
The cleanup removes the Safari capture directories, Firefox comparison captures,
temporary regression copies, and experimental Swift helper/cache. The report,
native diagnostic, revision server, setup fixture, and regression tests remain
in the repository. Raw run IDs above are historical identifiers, not retained
files. Reproducing a capture requires rerunning the documented commands.

Owned test windows, browsers, and both comparison servers are closed. The
existing development server and the user's regular browsers remain running.
Unrelated historical artifacts and the earlier Firefox native helper remain
untouched.

## Audit and reopened external-display investigation

The clean-code review finds two medium issues in the new Safari diagnostic.
The runtime and demo styles do not change during this audit.

| Finding | Correction | Coverage |
| --- | --- | --- |
| Display validation checks only one horizontal edge. Interrupted captures and captures with page errors can report success. | Validate the full window, scale, capture endpoints, focus, resize, scroll-end events, and interruption status. | Portable positive and negative cases, including negative display origins. |
| A failed window close can still report success. A server-close failure can skip the final report. | Record window ownership before navigation, attempt every cleanup, mark cleanup failures, and handle native sampler failure. | Cleanup failure injection and a native Safari smoke run. |

The repeat review finds no remaining high or medium issues in those audit
changes. At this stage, the reopened Safari issue blocked the release.
Verification passed 1,044 unit tests, 44 profiling-tool tests,
type checking, the production build, isolated consumer builds, and the WebKit
footer regression. The testing review uses parameterized boundary cases.
Generated display rectangles are a possible property-testing extension, but
no new testing dependency is necessary for the demonstrated failures.

The audit smoke run (`KlBvVx`) uses the default row layout, not the user's
small-card masonry layout. It cannot resolve the renewed report. Read-only
inspection of the affected tab confirms the current compositing hints and
small masonry cards, with concurrency 6. The affected chat has a 60,446-pixel
scroll height. The user confirms that both demos still jitter after reload on
the external display, while the built-in display is smooth.

New native captures use Safari 27 at 1920 × 997, DPR 2, on the 60 Hz LU28R55.
Gallery starts with a 3,477-pixel scroll height, then loads a page to reach
6,699 pixels. The workload uses the same six native gestures as above.

| Run | Workload/control | Maximum callback gap | Gaps above 25 ms | WebContent CPU |
| --- | --- | ---: | ---: | ---: |
| `jK2hei` | Small masonry, native CPU sampling | 97 ms | 5 | 3.34 s |
| `SKR8WN` | Small masonry, boundary geometry reads | 39 ms | 4 | 3.26 s |
| `Ph6GcZ` | Small masonry, row layers only | 30 ms | 1 | 3.40 s |
| `3HIUpV` | Small masonry, viewport and row layers | 32 ms | 1 | 3.25 s |
| `rFkdvU` | Small masonry, unchanged runtime | 29 ms | 1 | 3.13 s |
| `ghkJmw` | Synthetic rich chat, unchanged runtime | 43 ms | 3 | 2.09 s |

Every capture records six scroll-end events, zero application scroll writes,
and no page errors. The geometry diagnostic covers 386 mount/unmount pairs.
Surviving coordinates and heights remain unchanged, as does the scroll
position at each boundary. This does not measure presented pixels.

The three lightweight compositing controls show similar timing. No control
demonstrates a performance improvement, and none changes the development
page or runtime source. The sampled and geometry-instrumented runs are not
strict timing comparisons. The rich-chat fixture starts with a 21,498-pixel
scroll height, so it does not match the user's longer history exactly.

Reproduce the matched gallery configuration with:

```sh
GALLERY_LAYOUT=masonry GALLERY_SIZE=s node scripts/firefox-profile/safari-scroll.mjs
```

For the synthetic chat, set `DEMO=streaming RICH_CHAT=1 MATCH_OPTIONS=1`.
At this stage, the next measurement required real trackpad input in the
affected tab, and the requested `v0.2.0` release remained on hold.

## Delayed geometry and hover checks

The user reports subtle shifts at mount/unmount boundaries after the severe
jitter subsides. The geometry diagnostic now also checks surviving rows on
zero-delay and 50 ms timers after a batch starts. These are diagnostic layout
reads, not additions to the runtime or the animation-frame sampler.

The external-display gallery capture `KPJnTY` uses a 1920 × 959 viewport,
DPR 2, and a 913-pixel scroll container. Across 193 mounts and 193 unmounts,
3,182 delayed surviving-row comparisons show zero coordinate or height
changes. It records six scroll-end events, zero application scroll writes,
and no capture invalidations. Its maximum callback gap is 37 ms. The smaller
viewport and geometry reads prevent a strict timing comparison with the
previous lightweight controls.

The rich-chat capture `0YHdQU` uses a 1920 × 997 viewport and an 848-pixel
scroll container. Across six mounts and six unmounts, all 84 delayed
surviving-row comparisons show zero coordinate or height changes. It records
six scroll-end events, zero application scroll writes, no invalidations,
and a maximum callback gap of 29 ms. Neither capture measures physical
presentation or reproduces real trackpad momentum exactly.

A separate real-trackpad probe completes in the user's tab, but its data is
not saved and is no longer available when collection is attempted. Exclude
that probe from conclusions; completion alone is not measurement evidence.

Source inspection finds no hover-dependent padding, margin, dimensions,
typography, or positioning changes in gallery, streaming chat, or the pinned
Markdown renderer. Gallery cards have no hover rules. Chat actions and code
and table copy controls use opacity without removing their layout space. The
chat pointer handler changes its input-mode attribute only when pointer type
changes; it does not measure or reposition rows on pointer movement.

The loaded-CSS guard in
[`hover-layout-regression.mjs`](../../scripts/regressions/chat-scrolling/hover-layout-regression.mjs)
checks nested rules and renderer styles, rejecting layout properties and
custom-property changes in hover rules. This guards against accidental CSS
spacing changes, not compositor defects. The remaining visible shift is
unresolved; no additional runtime patch is justified by these captures.

The WebKit guard passes all 20 streaming-chat hover rules and the gallery's
single header-link hover rule. Playwright Firefox fails during browser startup
with a graphics initialization error; its hover check does not run. The owned
stalled Firefox process is stopped, and both native Safari capture windows
and their temporary servers close. These new captures remain local while the
investigation is open; the earlier cleanup section describes the prior round.

## User-provided Safari timeline

The user supplies a local Web Inspector timeline from the affected streaming
chat. The export covers 14.09 seconds, includes 672 scroll events and 646 wheel
events, and contains no user timing marks or screenshots. Layout quads describe
a 1420 × 997 root, narrower than the earlier 1920-pixel native captures.
Inspector instrumentation and the different width prevent direct comparison
of its timings with those captures. The raw export stays outside Git.

| Activity | Count | Total recorded duration | Maximum event |
| --- | ---: | ---: | ---: |
| Scroll handlers | 672 | 44.57 ms | 1.07 ms |
| Wheel handlers | 646 | 33.48 ms | 3.89 ms |
| Style recalculation | 160 | 32.67 ms | 2.01 ms |
| Layout | 70 | 17.67 ms | 1.59 ms |
| Forced layout | 1 | 0.13 ms | 0.13 ms |
| Paint | 242 | 33.51 ms | 1.55 ms |
| Composite | 760 | 274.85 ms | 13.29 ms |

These durations overlap: paints occur inside composite intervals, and some
script records describe nested work. Do not add the rows as exclusive CPU
time. Composite duration is not GPU utilization or presentation latency.

Of 20 composite events longer than 4 ms, 14 have no layout event between the
previous composite's end and their start. Several of the longest events
contain 512-pixel tile repaints spanning the page width. This points to
scrolling/compositing work as well as row-window changes; it does not identify
which DOM element owns a backing store. The export has 42 sampled stacks, all
with zero timestamps, so those samples cannot locate a particular visible
shift in time. Pointer-over and pointer-move handlers total less than 1 ms.

Removing the canvas-wide `translateZ(0)` while retaining row layers produces
worse jitter in the user's repeat. That candidate is rejected and reverted.
The next candidate keeps the canvas layer and adds `preserve-3d`, testing a
different structural-layer path described in
[WebKit's GraphicsLayerCA implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/ca/GraphicsLayerCA.cpp).
This is a hypothesis, not an established root cause or completed fix.

The user reports smooth scrolling with small shifts still visible after this
change. A read-only inspection of that Safari chat tab finds a 1920 × 998
viewport at DPR 2, a canvas origin on whole CSS pixels, and all seven mounted
row offsets and heights on whole CSS pixels. It does not support adding
another rounding step to row placement. This is a stationary observation,
not a measurement of physical positions during a gesture.

With this candidate, the WebKit gallery paging checks pass at DPR 1, 2, and
1.25 for masonry, and at DPR 1 and 2 for rows. The three WebKit dynamic-resize
modes also pass. The existing gallery script's printed Firefox label is
unchanged, but these particular checks substitute Playwright WebKit for the
browser launch. The type/style check and all 44 profiling-tool checks pass.
These are correctness checks, not native Safari presentation evidence.

The fixed-gallery baseline `D42xOZ` retains 120 photos, disables paging, and
uses two gestures in each direction. It records 94 mounts and 94 removals in
10 batches, four scroll-end events, zero scroll writes, and a 28 ms maximum
callback gap. The all-mounted control `ai3lu4` receives no input and starts
unfocused. It is invalid and excluded. The runner now rejects an unfocused
start before sending gestures. `RECYCLING=retain|all` remains diagnostic-only;
neither mode is a proposed unbounded production workaround.

## Retained candidate and isolated follow-up

The user's latest repeat is nearly perfect, with occasional shifts still
visible. The user cannot reliably distinguish whole-row movement from text
shimmer. The user asks to preserve this version while testing further
hypotheses on temporary servers. Before the approved engine guard below, its
runtime SHA-256 is
`2384bd95a2cbb42857b6a9f3bacad760beb9b67cca3c34a77f1a9f129f8016ba`.

Three native Safari captures use the same external display, 1920 × 997
viewport, 120-photo small-card masonry layout, and fixed 3,477-pixel canvas.
Each uses two downward and two upward 1,080-pixel gestures. Paging is disabled
only in these diagnostic servers. These are single exploratory runs, not a
repeated performance benchmark or proof of physical smoothness.

| Configuration | Local run | Mounts / removals | Maximum callback interval | Intervals above 25 ms | WebContent CPU / elapsed time |
| --- | --- | ---: | ---: | ---: | --- |
| Retained candidate | `aa9Ymh` | 94 / 94 | 20 ms | 0 | 2.11 s / 12.65 s |
| All 120 items mounted | `S9YOMw` | 0 / 0 | 30 ms | 1 | 2.15 s / 12.64 s |
| Retained candidate plus scroll-container isolation | `uBoPH1` | 94 / 94 | 31 ms | 3 | 2.05 s / 12.57 s |

All three captures complete four gestures and four scroll-end events with
zero application scroll writes, page errors, or capture invalidations. The
first two show monotonic scroll positions within every gesture, with only
12- or 24-pixel steps and exact 1,080-pixel endpoints. The all-mounted control
does not establish a timing or CPU benefit. It does not establish whether the
remaining physical shift survives without recycling.

The isolation control tests `isolation: isolate` on the viewport while keeping
the current canvas and row layers. A
[WebKit stacking-context report](https://bugs.webkit.org/show_bug.cgi?id=216701#c3)
motivates this hypothesis, but it is not evidence that this application has
the same defect. This trial shows no clear improvement, so isolation is not
added to the runtime or demo CSS.

The diagnostic now records the runtime source hash and computed canvas and
viewport layer styles before capture. The frame sampler still performs no
style or layout reads. The `rows` and `viewport` controls explicitly remove
both canvas promotion declarations, including the newer `preserve-3d`, to
avoid silently retaining the layer they are meant to exclude. All three
temporary Safari windows and servers close after their captures.

## Firefox check and WebKit-only scope

The first follow-up captures use the retained runtime without changing source
or demo CSS. Installed Firefox 155.0.1 runs on the external LU28R55 with fresh
temporary profiles, closed DevTools, native input, and a 1900 × 965 viewport
at DPR 2. Gallery `7euNWe` records 526 scroll events, a 17.56 ms maximum frame
callback interval, 570.65 ms of content-main CPU, and 380.99 ms of Renderer
CPU. Idle chat `bRhpf4` records 520 scroll events, a 17.52 ms maximum interval,
354.24 ms of content-main CPU, and 301.20 ms of Renderer CPU. Both complete
six gestures with zero scroll writes or intervals above 25 ms. Chat stays
close to the earlier capture; the gallery CPU increase requires a controlled
comparison rather than a no-regression claim.

The [canvas compositing fixture](../../scripts/firefox-profile/fixtures/canvas-compositing.js)
changes only the test page's canvas `transform-style`. Both variants run the
same setup and post-setup warmup. Use this command, changing only the query
value between `flat` and `preserve-3d`. Use `runtime` to check the runtime's
actual selection without overriding it.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url='http://127.0.0.1:5173/demos/gallery/?profile-canvas=flat' \
  --layout=masonry \
  --setup=scripts/firefox-profile/fixtures/canvas-compositing.js \
  --down=3 --up=3 --ticks=90 --delta=12 --settle-ms=1200 \
  --warmup-ms=2000 --live --output=browser-artifacts/firefox-safari27-check
```

The six captures run sequentially in the table's order. All start with the
same 4,940-pixel canvas, load the next page to reach 9,627 pixels, and complete
six scroll-end events with zero scroll writes or intervals above 25 ms.

| Canvas mode | Local run | Duration | Content-main CPU | Renderer CPU | Maximum callback interval |
| --- | --- | ---: | ---: | ---: | ---: |
| Flat | `2N2lNx` | 18.32 s | 285.83 ms | 280.86 ms | 17.54 ms |
| Preserve 3D | `CyI55B` | 18.20 s | 428.54 ms | 318.04 ms | 17.66 ms |
| Preserve 3D | `YSd3yl` | 18.03 s | 455.66 ms | 337.57 ms | 17.64 ms |
| Flat | `tYUcHo` | 18.03 s | 391.66 ms | 354.37 ms | 17.68 ms |
| Flat | `E54iBa` | 18.42 s | 262.79 ms | 256.21 ms | 17.52 ms |
| Preserve 3D | `UawO64` | 18.42 s | 358.39 ms | 274.75 ms | 17.60 ms |

Content-main CPU medians are 285.83 ms for flat and 428.54 ms for preserve 3D,
with ranges of 262.79–391.66 ms and 358.39–455.66 ms. Renderer medians are
280.86 ms and 318.04 ms, with overlapping ranges of 256.21–354.37 ms and
274.75–337.57 ms. The higher content-main median is about 0.8 percentage
points of one CPU core over an 18-second capture. This is a small sample
with variation, not evidence of a physical frame-rate regression or a precise
universal overhead. The gallery still fetches real images; equal request
counts do not guarantee identical network or image-decode timing.

The user approves scoping `preserve-3d` to WebKit. The runtime checks support
for WebKit's `-webkit-nbsp-mode: space` once during list creation. It does not
set that property or add work to scroll handlers. Native Safari 27 and
Playwright WebKit accept the capability; Playwright Chromium rejects it.
Desktop WebKit rejects `-webkit-touch-callout`, so that alternative cannot
serve as the guard. This is an engine-specific workaround, not detection of
the compositor defect itself. Recheck its scope when updating browser targets.

Safari retains the same canvas transform, `preserve-3d`, row-layer hints,
and mount-before-attach ordering. Other engines retain the canvas transform,
row hints, and mounting order without the extra 3D preservation. No public API,
scroll geometry, or demo stylesheet changes in this follow-up.

Four new unit cases cover supported, unsupported, missing-support-function,
and missing-CSS environments, including row recycling. The three non-WebKit
cases fail before the guard and pass afterward. All 1,048 unit tests and 44
profiling-tool checks pass. Type/style checks and direct type checking of the
edited test file pass. The six Chromium/WebKit dynamic-resize cases verify
the engine selection and retain their existing behavior checks. The first
unit-suite attempt is blocked by sandbox localhost restrictions in the relay
tests; the permitted repeat passes. The remaining occasional Safari shift
has no verified cause yet.

The final installed-Firefox capture `kZZh6I` uses `profile-canvas=runtime`,
without a style override. It confirms `webkit: false` and computed
`transform-style: flat`, while retaining the canvas transform. It completes
six gestures and six scroll-end events with 533 scroll events, zero writes,
zero intervals above 25 ms, and a 17.60 ms maximum callback interval.
Content-main CPU is 298.42 ms and Renderer CPU is 288.07 ms, within the flat
control ranges. This checks the final selection and performance; it does not
measure physical presentation in Safari.

All nine follow-up Firefox captures remove their temporary browser profiles.
The final process audit finds no owned profiling browsers, capture helpers, or
temporary servers still running. The pre-existing development server remains
untouched. Raw captures stay local and ignored under the repository workflow.

## Release cleanup and verification

The `v0.2.0` cleanup removes ten obsolete generated Vite caches and the
superseded manual Safari probe. The reusable native runner covers manual input
and remains in `scripts/firefox-profile/`. Reports, fixtures, and regression
scripts remain tracked. The current renderer-preview cache, raw captures,
user-provided timeline, and pre-existing development server remain untouched.

The release repeat passes `pnpm run check`, all 1,048 unit tests, all 44
profiling-tool checks, all 11 regression-runner checks, both isolated consumer
builds, and the production build. The formatter and `git diff --check` pass.
Unit tests still print dependency source-map warnings for omitted renderer
source files. Those warnings do not fail the tests.

No runtime code changes after the recorded WebKit-only guard checks. The
cleanup does not repeat native captures or browser regressions. Earlier
browser results retain their exact workloads and limitations above.
