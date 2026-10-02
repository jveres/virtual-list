# Streaming chat memory regression

Use `pnpm run test:memory` to check whether repeated scrolling reaches a bounded
memory plateau. The test measures installed browser processes, including graphics
allocations and compressed memory. JavaScript heap size alone misses these costs.

Start a performance investigation with the [Firefox workflow](firefox-profiling.md).
This additional test uses a fixed allocation workload. It does not determine
whether physical trackpad momentum looks smooth.

## Requirements

Run on macOS with Xcode Command Line Tools, Node.js 22 or later, and the installed
browser. Window placement and native input require Accessibility permission.
Safari requires remote automation and external agents to be enabled.

Keep the desktop unlocked and use the affected display. The runner creates an
isolated browser session, maximizes its window on the selected display, and keeps
DevTools closed. A temporary sleep assertion prevents idle display sleep during
the capture. A locked desktop, changed geometry, page error, incomplete workload,
or cleanup failure invalidates the run.

The default reference display is LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz. Budgets are calibrated for this configuration. Record and review a new
baseline before applying them to different hardware, display sizes, or browser
builds. Do not increase a budget merely to make a regression pass.

## Run the workloads

Run browsers sequentially so they do not compete for the display and graphics
memory. Each command starts and closes its own local server and browser.

```sh
pnpm run test:memory -- --browser=firefox --workload=text
pnpm run test:memory -- --browser=firefox --workload=images
pnpm run test:memory -- --browser=firefox --workload=streaming
pnpm run test:memory -- --browser=firefox --workload=streaming --trail=long
pnpm run test:memory -- --browser=safari --workload=images
pnpm run test:memory -- --browser=chrome --workload=images
```

The default is twelve cycles in one trial. Use `--cycles=6` for a shorter check;
six is the minimum needed for the plateau comparison. Limit comparison rounds to
three trials per browser and variant.

The workloads exercise different allocations:

| Workload | Input |
| --- | --- |
| `text` | The default simulated conversation, including history paging. |
| `images` | 48 imported turns with 24 distinct, locally generated 4000 × 3000 JPEGs. The complete data window loads before measurement. |
| `streaming` | The built-in fast, long reply over the default history. Token-delay randomness is fixed. Scrolling overlaps the reply, then continues after completion. |

The default trail mode is `off`, matching a fresh demo profile. Pass
`--trail=short` or `--trail=long` with the streaming workload to measure trail
allocations. The runner verifies the selected setting and requires rendered
trail rectangles during scrolling. It waits for the first rectangles before
starting, and the first instant-step cycle begins with ten alternating 120-pixel
steps near the reply before traversing history. This keeps the active trail
covered even if streaming finishes while the reply is later offscreen.
Selecting a trail with another workload fails before the browser starts.
The command and summary retain the selected
mode, so comparisons cannot silently substitute a trail-disabled run.

A default cycle sends 80 upward and 80 downward instant scroll steps, 900 CSS
pixels apart, every 40 ms, with 700 ms pauses. This intentionally stresses image
resources and row recycling. It does not simulate a physical gesture.

For native macOS pixel input, add `--input=native`. The runner sends 720 events in
each direction, 100 pixels apart, every 8,333 microseconds. It verifies wheel
input, movement, and scroll-end delivery. These events include gesture phases;
they do not reproduce physical trackpad momentum. Keep that window in front.

Use `--display=NAME` to select another display. `--url=URL` uses an existing demo
server; leave source files unchanged during capture. The default owned server
disables file watching and hot reload.

For a message-layer comparison, repeat the same command with
`--message-layers=off`. The default is `--message-layers=default`, which preserves
the demo's current browser-specific hints. The runner records computed message
hints and canvas transforms at checkpoints. This option does not disable image
or canvas hints. Start each variant in a fresh session; do not compare a warm,
already-scrolled tab with a newly opened one.

Use `--canvas-layer=off` to remove the canvas's `translateZ(0)` and WebKit
`preserve-3d` hints independently. Combine both options to remove message and
canvas hints together. Image hints remain unchanged. These controls remove
explicit layer requests; browsers still choose compositing for scrolling and
other content. They do not disable the browser's compositor.

For manual testing, use `?debug-compositing=no-canvas-layer` on the streaming demo,
or `?debug-compositing=no-canvas-layer,no-message-layers` for the combined control.

For a supplementary local image transcript, use `--workload=images
--transcript=/path/to/chat.md`. This mode requires the owned server and an exported
conversation with at most 48 User/Assistant turns. The file is served only from a
random URL on the local loopback server. The report retains its hash, not its
contents. Canonical synthetic input remains the regression gate because its
expected image coverage is known.

## Understand the result

A passing result requires real movement in every cycle. The image workload also
requires all 48 message keys to be visited, all 24 image rows to decode during the
trial, and a stable document height across completed cycles. The streaming
workload must observe an active reply during scrolling and its later completion.
When a trail is requested, at least one cycle must also observe rendered trail
rectangles; an enabled setting alone is not sufficient.

The test reads `proc_pid_rusage` physical footprint and lifetime peak for owned
processes. A lifetime peak catches temporary graphics explosions even when the
allocation has already become reclaimable at a checkpoint. Process totals can
include shared accounting; they are not an exact measure of unique physical RAM.

Safari's WebKit services have `launchd` as their parent. The runner resolves each
service's responsible application and includes only the isolated Safari process
and its services. This uses a private macOS ownership API also used by
[Chromium](https://chromium.googlesource.com/chromium/src/+/24aa2a50ac03698e7ec5a11251a615b965f5874d/base/process/process_info_mac.cc).
Unavailable ownership information invalidates the run. Older captures selected
new WebKit processes by launch time and may include other applications; use new
paired captures for the compositing decision.

The reference budgets are:

| Metric | Limit |
| --- | ---: |
| Largest process lifetime peak, Firefox/Chrome | 600 MiB |
| Largest process lifetime peak, Safari | 768 MiB |
| Sum of process footprints at a cycle checkpoint | 1,400 MiB |
| Last-three-cycle median minus first-three-cycle median | 64 MiB |
| Range of the final three cycle totals | 40 MiB |

The current large-image Chrome control exceeds the provisional process-peak
limit despite bounded repeated-cycle memory. Its blank-page startup peak also
approaches that limit. Keep the failure visible; Chrome needs a comparable
original-code baseline and attribution before treating this limit as a calibrated
release gate. The [investigation report](reports/chat-memory-2026-09-29.md)
records this limitation and the rejected display-copy experiment. Firefox and
Safari have passing measured references on the configuration above.

A whole Firefox instance has a substantial parent/GPU/process baseline. A total
near 1 GiB can be stable even when the chat content process is small. Compare the
process breakdown and repeated growth as well as the total.

Each run also measures a fresh blank page at the same display geometry before
loading the demo, and a blank page ten seconds after navigating away. The latter
runs after the category diagnostics. Navigation can retain the chat in the
browser's back/forward cache, so this second blank page is not a browser-only
floor. Subtracting totals does not give an exact per-tab cost: processes can
share memory, and caches and background startup work change during a run.

The runner takes compact VM-category summaries after measurement. Firefox also
provides selected `about:memory` counters afterward; opening that page can affect
caches, so those counters diagnose ownership rather than replace the measured
peak. The test never forces garbage collection or sends global low-memory
notifications.

## Check source ownership across runtime lifecycles

The separate lifecycle diagnostic checks replacement within one list, paging
with eviction, disposal with API handles released, and disposal with old API
handles deliberately retained. It also keeps empty retired elements while
replacing source data, and disposes lists during a resize callback after new
observer registrations are queued. These cases distinguish host DOM ownership
from stale runtime references. The fixture uses synthetic source items and
measured rows, without the Markdown renderer, storage, or remote assets.

```sh
node scripts/firefox-profile/runtime-retention.mjs --cycles=12 --display=LU28R55
```

The runner owns its server, installed Firefox instance, and temporary profile.
It checks movement, scroll-end delivery, paging progress, and display geometry.
Every four cycles it records process footprints, then requests Firefox's
`minimizeMemoryUsage` operation through a temporary `about:memory` tab. This
forces garbage collection, cycle collection, and memory-pressure cleanup.
Weak references count surviving source items and rendered row roots without
keeping those objects alive. Memory reporters measure the fixture's window
subtree and the content process heap separately.

Unlike `test:memory`, this diagnostic changes normal collection and cache
behavior. Use it to identify strong ownership, not to predict natural GC
timing, scrolling speed, or physical presentation. A surviving disposed handle
still owns configuration and geometry metadata. Host callbacks can also retain
source data independently. The fixture does not inspect those host stores.

Compact summaries and reproduction patches remain under ignored
`browser-artifacts/runtime-retention/`. Per-run profiles, native helpers,
compiler caches, and servers are removed. No raw heap snapshot is saved.
The [October 1 comparison](reports/runtime-retention-2026-10-01.md) records
the measured source-retention fixes and their limits. The
[October 2 observer comparison](reports/runtime-observer-ownership-2026-10-02.md)
covers retained elements and canceled registration queues.

Run the portable fixture regression with:

```sh
pnpm run test:regression -- --group=runtime --match=runtime-retention
```

It verifies lifecycle behavior in Firefox, Chromium, and WebKit. Chromium's
CDP garbage collector additionally checks item and row reachability; the
installed-Firefox diagnostic remains the primary memory comparison.

## Compare runtime data structures

Use the same installed-Firefox runner with the `structures` workload to compare
retained geometry storage and synchronous API costs:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures --display=LU28R55 --output=browser-artifacts/data-structures
```

The deterministic fixture covers 1,000, 10,000, and 100,000 items in fully
measured geometry, sparse measured geometry, four-lane positioned geometry,
and mounted stacked and positioned lists with declared heights. It checks
offsets, membership, edits, reorders, append/remove and prepend/remove pairs,
movement, scroll-end delivery, and release.
Memory checkpoints follow forced collection. Timed operations run between
checkpoints, with a warmup and batched samples; they are API wall times, not
sampled CPU, boot timings, or native gesture measurements.

Use `--workload=structures-natural` to add a post-operation checkpoint before
requesting collection. The summary marks it with `minimize: false`. Loaded
and released checkpoints still force collection. The extra checkpoint opens a
diagnostic tab and can observe uncollected objects; it does not measure GC
pauses or allocation rate. Process lifetime peaks include all earlier cases
and diagnostics in the same session.

The summary keeps window allocations separate from process heap, resident
memory, unclassified heap, and per-class totals. These metrics overlap and
must not be added together. Reporter attribution can change after repeated
allocations; compare matching checkpoints and inspect the accounting before
claiming a saving. Invalid process-counter samples are recorded and retried
at most twice; persistent invalid counters fail the run.

Run the fixture correctness checks in Firefox, Chromium, and WebKit with:

```sh
pnpm run test:regression -- --group=runtime --match=data-structures
```

The [October 1 investigation](reports/runtime-data-structures-2026-10-01.md)
records the retained changes, sparse-storage tradeoff, and measured limits.
The [key-index follow-up](reports/runtime-key-index-2026-10-01.md) records the
structural update batches, unforced checkpoints, and peak-memory limits.

Add `--diagnostic` to a structures workload with an owned server to collect
per-case JavaScript samples and GC/CC slices in installed Firefox:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --output=browser-artifacts/structure-diagnostics
```

This mode adds gap-anchor queries, a nested-overlap control, isolated Fenwick
construction, and a buffer-accounting probe. The probe reads `.buffer` from live
numeric arrays after the exercised checkpoint, then collects again. It helps
distinguish missing attribution from released backing storage.

Each case gets a separate 2 ms profile. The compact summary clips GC and cycle
collector slices to marked workload phases, including warmup and frame waits
but excluding diagnostic collections. Runtime frame counts include native work
below the recorded JavaScript frame; they are not exclusive CPU times. Profiling
adds overhead to timing and memory. Process footprints remain checkpoint and
cumulative lifetime measurements, not per-operation allocation rates. Raw
profiles are deleted immediately after parsing, including on parser failure.

The [allocation and anchor study](reports/runtime-allocation-anchors-2026-10-01.md)
records the matched baseline, candidate, repeat, and accounting limits.
The [declared-snapshot comparison](reports/runtime-declared-snapshots-2026-10-02.md)
records compact snapshot columns and the subsequent staging improvements.

## Exercise sustained paging without forced collection

Use `paging-natural` to investigate page overlap, cancellation, live edits,
eviction, and natural collection over a longer sequence:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=paging-natural --cycles=120 --diagnostic --display=LU28R55 --output=browser-artifacts/paging-natural
```

The synthetic cases use stacked lists with 480 and 10,000 retained items, and
a four-lane positioned list with 2,000 retained items. Each page contains one
quarter of the item budget and overlaps its neighbor by 20%. Each cycle edits
an overlapping item, loads a page, and reconciles eviction. Every fourth cycle
also cancels a load whose source resolves afterward. The final quarter of the
cycles pages in the reverse direction. Assertions check preserved edits,
bounded ownership, actual movement, scroll-end events, and row disposal.

The runner forces collection before and after each case, but never between its
cycles. It samples process footprints every twenty cycles and at the end,
without opening diagnostic tabs during the cycle sequence. The default is
twelve cycles; the supported range is 4–960 in multiples of four without
profiling, or 4–240 with `--diagnostic`. The shorter profiled limit preserves
the recorded workload markers. The optional profile records per-cycle
JavaScript samples and GC/CC slices. Edit, load, and
reconcile timings include awaited work and are wall times, not exclusive CPU.
Lifetime process peaks can include earlier cases and diagnostics. This workload
doesn't measure native input or physical presentation.

If a short control ends while memory is still rising, use a longer sequence
without profiling to check whether growth reverses naturally:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=paging-natural --cycles=960 --display=LU28R55 --output=browser-artifacts/paging-natural-long-control
```

Compare matching durations for before/after claims. Changing the duration also
changes when the workload reverses direction. The
[paging and memory comparison](reports/runtime-paging-memory-2026-10-02.md)
records the rejected pager prototypes and the 240/960-cycle controls.

Run the fixture's correctness regression with:

```sh
pnpm run test:regression -- --group=runtime --match=paging-structures
```

This checks twelve cycles of each case in Firefox, Chromium, and WebKit. Its
headless results establish correctness only. The
[investigation record](reports/runtime-investigations-2026-10-02.md) tracks the
installed-Firefox measurements for this workload.

## Sample allocations during measured streaming

Use `mixed-natural` for 480- and 2,000-item measured lists. It keeps the paging
overlap, cancellation, reversal, and eviction checks, and adds six live text
edits per cycle, asynchronously sized inline SVG images, and a width change
every fourth cycle. The fixture verifies decoded image dimensions and mounted
row heights. Its animation-frame sampler reads timestamps only.

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=mixed-natural --cycles=40 --diagnostic --allocations --display=LU28R55 --output=browser-artifacts/measured-streaming-allocations
node scripts/firefox-profile/runtime-retention.mjs --workload=mixed-natural --cycles=120 --display=LU28R55 --output=browser-artifacts/measured-streaming-control
```

`--allocations` requires `mixed-natural` and `--diagnostic`. It enables Firefox's
sampled JavaScript-object allocation markers and limits runs to 40 cycles to
reduce trace-buffer overflow. Compact summaries retain counts,
the sum of sampled object sizes, classes, and nearest page/runtime call sites
inside marked workload phases. These are not all allocated bytes, retained
memory, or object lifetimes. A runtime caller can include host allocations
beneath it; compare the nearest page frame before attributing ownership.
The capture fails if allocation sampling produces no markers.

Allocation profiling changes execution and memory use. Use ordinary matched
controls for performance comparisons. Omitting `--allocations` but keeping
`--diagnostic` retains JavaScript samples, approximate content-main-thread CPU,
rendering markers, and GC/CC slices. Native allocation tracking requires Firefox
Nightly; this runner uses the installed release browser and does not install
another build. See [Firefox's allocation documentation](https://raw.githubusercontent.com/firefox-devtools/profiler/main/docs-user/memory-allocations.md)
for the different sampling scopes.

The paging regression also covers these two measured cases in all three
engines. For a focused fixture check, set `PAGING_WORKLOAD=measured`; optionally
set `PAGING_BROWSER=firefox`, `chromium`, or `webkit`. These headless checks
remain correctness checks, not performance evidence.

## Measure huge rows and unequal resize work

Use the rendering fixture to investigate work inside a measured row or the
cost of resizing rows with different amounts of content:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=huge --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/huge-rows
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=resize --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/uneven-resize
pnpm run test:regression -- --group=runtime --match=rendering-workload
```

The huge-row cases use the demo Markdown renderer for ordinary and very large
multi-block rows, a 3,000-line code fence, and a 1,200-row table. The resize cases
compare uniform rows, a mixture of small and large rows, and one giant row.
Assertions cover prefix geometry, content, selection, actual movement, and
cleanup. Creation timing starts after module initialization and does not replace
`profile:boot`. Traversals use instant API offsets and do not model native
gesture release or physical presentation.

The experimental `--variant=skip` applies block-level `content-visibility: auto`
after exact measurement. It is intentionally separate from the default control
and currently fails full-row selection in installed Firefox. Treat that run as
invalid for speedup claims. `RENDERING_VARIANT=skip` reproduces the experiment
in the regression; `RENDERING_BROWSER` can select a single engine.
The [rendering and allocation report](reports/runtime-rendering-allocation-2026-10-02.md)
records tested conditions, rejected candidates, and source revisions.

## Compare constrained table algorithms

The table fixture gives both variants explicit column widths and wrapping
rules. It covers ordinary cells, long unbroken text, and decorative images,
with repeated traversal, width changes, and live cell edits:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=table --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/table-layout-baseline
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=table --variant=fixed --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/table-layout-fixed
pnpm run test:regression -- --group=runtime --match=table-layout
```

The candidate changes only `table-layout` from `auto` to `fixed`. These are
host-owned tables with a declared column policy; they do not represent the
renderer’s default content-sized Markdown tables. Checks verify every cell's
overflow, complete text selection, edit-content hashes, row geometry, actual
movement, and disposal. Geometry validation runs outside timed phases and the
animation-frame sampler. Use a restored `plain` control before deciding whether
a measured difference justifies an implementation.
The [October 2 comparison](reports/constrained-table-layout-2026-10-02.md)
rejects a production change for these cases.

## Compare large-row preparation

The construction fixture uses the demo's Markdown renderer and staging hook
for many independent blocks, one large code fence, and one large table. It
measures readiness after module initialization, not demo boot. Timestamp-only
frame sampling starts before rendering and DOM creation.

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=construction --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/row-construction
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=construction --variant=nested --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/row-construction-nested
pnpm run test:regression -- --group=runtime --match=row-construction
pnpm run test:regression -- --group=runtime --match=staged-row
```

`plain` uses the current production hook. `nested` retains the exploratory
code/table slicing control; it is not a production recommendation. To compare
the old hook, restore its recorded revision and source patch from the
[October 2 report](reports/large-table-staging-2026-10-02.md). Current `plain`
already stages large tables. Compare the worst preparation gap, total readiness,
and CPU together. The `markup` and `dom` phases are inside `prepare`; do not
sum them with the parent phase. Correctness checks cover selection after width
changes, complete markup, node identity, geometry, cancellation, and disposal.

## Compare exact and estimated history preparation

The history fixture compares exact `updateWindow` preparation against a pinned
TanStack reference with provisional geometry. Both use the same deterministic
content, renderer, dimensions, zero overscan, and row retention by key. This
measures loaded-history preparation after module initialization, not demo boot.

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=history --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/history-exact
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=history --variant=estimated --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/history-estimated
pnpm run test:regression -- --group=runtime --match=estimated-history
```

Compare completion, sampled CPU, frame gaps, exact total-height error, target
accuracy, reading anchors, and measured-row counts together. The reference's
width-change adapter explicitly restores the reading anchor. Its size formula
is a fixture estimate, never a declared runtime height. A full-layout oracle
runs after timing, so whole-run peaks include validation allocations.

Current `plain` includes the retained at-rest preparation change. Restore the
baseline patch from the [October 2 report](reports/history-preparation-2026-10-02.md)
to compare the old eight-row cap. The reference dependency is development-only;
its pinned version and integrity are recorded in the lockfile.

## Preserve reproducibility

Each run keeps `summary.json`, `reproduce.json`, and `reproduce.patch` under ignored
`browser-artifacts/memory/`. These record the revision, source hashes and patch,
command, workload, browser version, display geometry, and process measurements.
Source metadata is captured before launch. Temporary browser profiles, per-run
helpers, server caches, and raw process reports are removed after analysis.

The deterministic input and thresholds make this a repeatable regression test;
OS allocation and scheduling are not byte-for-byte deterministic. Failed or
invalid runs are retained as such. Never treat a stationary, locked, or
incomplete run as a low-memory success.

Run portable analyzer and profiler checks with `pnpm run test:firefox-profile`.
Keep measured findings in [the reports directory](reports/README.md), with raw
captures excluded from version control.
