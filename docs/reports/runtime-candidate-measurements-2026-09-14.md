# Runtime candidate measurements: September 14, 2026

This report tests the [static review](runtime-static-review-2026-09-14.md)
against main commit `6fc4434`. Bounded hidden-row retention reduced CPU in
three paired chat captures. Larger staging batches reduced append latency
but increased peak frame work. No production runtime, demo, integration, or
public API changed.

This report records the pre-implementation investigation. The later
[hidden-row implementation report](hidden-streaming-row-2026-09-14.md) records
the approved patch, lifecycle coverage, and fresh native comparisons.

The table separates measured benefits from unsupported proposals:

| Candidate | Evidence | Decision before any production change |
| --- | --- | --- |
| 1: Retain a hidden streaming row | Median chat CPU: 2,241 ms to 1,650 ms, about 26% lower. | Performance benefit established for this workload. Lifecycle and cross-browser safety remain open. |
| 2: Copy fewer pager arrays | Small, variable component savings. No repeatable chat CPU reduction. | Do not justify a runtime patch with the current performance evidence. |
| 3: Raise staging cap to 64 | Rich append: 188 ms to 54 ms. Largest staging refresh tick: 5.60 ms to 20.13 ms. | Reject this fixed-cap prototype because peak frame work increases. |
| 4: Consolidate structural passes | A 10,000-item structural update costs about 7 ms. | Cost exists, but no consolidation gain is established. No prototype promoted. |
| 5: Publish a geometry revision | Synthetic refresh with 100 headers costs about 2.5–4 microseconds per call. | No measured basis for expanding the public API. |
| 6: Reduce scroll allocations and timers | All nine chat captures have scroll-handler maxima below 1.1 ms. | No attributed scroll-allocation problem or timer-change benefit established. |

## Environment and isolation

All captures used installed Firefox 155.0.1 on the LU28R55 external display.
The display reported 1920×1080 logical pixels, 2× scaling, and 60 Hz.
Firefox content measured 1900×965 logical pixels. Each capture used a fresh
temporary profile, closed DevTools, and live native profiling at 1 ms.
There was no CPU or network throttling.

The [Firefox workflow](../firefox-profiling.md) governed capture and cleanup.
Native macOS input supplied gesture phases, not Playwright wheel events.
The frame sampler read cached scroll positions without DOM layout reads.
CPU analysis ran after the paired captures, not alongside them.

The preparation script copied the source into ignored
`browser-artifacts/static-review-v6Wn2a/`. Each variant changed only its
copied files. The root `src/`, `demos/`, and `integrations/` remained identical
to `HEAD`. Existing documentation edits remained intact.

The bounded-retention prototype kept at most one measured row connected.
It skipped removal and reinsertion when that same row remained resident.
Multi-row measurement retained the existing detach behavior. This differs
from retaining an arbitrarily large last batch.

The pager prototype copied only pages that owned the updated item.
It copied the flat array with `slice()` and replaced one entry. It did not
add an index cache or cache the previous projected row key. The staging
prototype changed only the eight-row cap to 64 and retained the 3 ms render
budget. These are experimental variants, not approved patches.

## Full-chat CPU comparison

The built-in fast long reply used fixed midpoint token delays of 8 ms.
The setup replaced `Math.random` only inside each fresh profiling page.
This removes randomized deadlines, but event-loop scheduling still varies.
No private transcript or provider credentials were used.

Each capture used 12 upward gestures of 90 ticks at 60 pixels per tick.
Tick spacing was 16.667 ms, with 700 ms release pauses. Warmup was 2 seconds
before and after setup. Runs alternated baseline and experimental variants.
The table lists all nine runs in execution order.

| Run | Variant | Content CPU (ms) | Average CPU, one core (%) | Longest awake interval (ms) | Scroll handler p95 / max (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| `run-DnuUFU` | Baseline | 2,241.265 | 7.394 | 12.820 | 0.481 / 0.770 |
| `run-pnfkeK` | Retention | 1,650.315 | 5.460 | 17.089 | 0.430 / 0.956 |
| `run-vOtnyh` | Pager | 2,556.228 | 8.609 | 13.771 | 0.464 / 0.957 |
| `run-rCf8uj` | Pager | 1,897.116 | 6.159 | 11.850 | 0.303 / 0.772 |
| `run-syghI6` | Retention | 1,753.447 | 5.754 | 14.686 | 0.520 / 0.886 |
| `run-HIN0z0` | Baseline | 2,628.195 | 8.853 | 12.197 | 0.549 / 0.984 |
| `run-G41vCP` | Retention | 1,370.360 | 4.486 | 11.548 | 0.394 / 0.746 |
| `run-Cw6OBE` | Baseline | 2,177.127 | 7.121 | 12.295 | 0.418 / 0.870 |
| `run-NngUhv` | Pager | 2,267.852 | 7.465 | 12.031 | 0.470 / 1.022 |

Retention CPU ranged from 1,370–1,753 ms, below all baseline runs at
2,177–2,628 ms. Median CPU fell about 26%, including host rendering and
other content-thread work. Nearest-JavaScript samples in `measureMany` and
its callbacks fell from 701–749 to 1–7. Those samples include native layout
work beneath JavaScript, not only JavaScript execution.

Retention did not consistently reduce the longest awake interval.
The median increased from 12.295 ms to 14.686 ms. An awake interval can
contain several tasks. These results do not establish a CPU-spike fix.

Pager CPU ranged from 1,897–2,556 ms and overlapped the baseline range.
Its median was 2,268 ms, compared with the baseline's 2,241 ms.
The data does not show a repeatable full-chat benefit.

All nine runs recorded 718–729 scroll events and 13 scroll-end events.
They followed the same paging sequence and finished at the same geometry:
`scrollTop = 0`, `scrollHeight = 30959`. Each recorded three scroll-position
writes. No frame interval exceeded 25 ms. Regular callbacks do not prove
smooth physical presentation or replace real trackpad-momentum testing.

## Deterministic component comparisons

Three additional browser sessions ran three alternating rounds per case.
The runs were `run-HuTsuc`, `run-exiEAB`, and `run-QtMB1E`. A separate
10,000-row control received native scrolling while hidden surfaces exercised
the components. These are isolated component measurements, not chat latency
or field measurements.

Each component session completed its geometry and source-update assertions.
The native control recorded 1,050–1,066 moving frames and 12 scroll ends.
It returned to its initial position after six downward and six upward gestures.
No sampler layout reads or simulated wheel events were used.

| Component | Baseline, median (range) | Prototype, median (range) | Scope |
| --- | --- | --- | --- |
| Detached measurement | 77 ms (68–98) | 16 ms (13–26) | Sum of 200 measured updates per round. |
| Pager live updates | 81 ms (63–108) | 75 ms (53–99) | 10,000 updates over three pages and 160 unique items, with a fake runtime. |
| Simple staged append | 184 ms (184–186) | 51 ms (50–52) | Add 80 rows to 20 retained rows. |
| Rich staged append | 188 ms (186–189) | 54 ms (52–56) | Each row contains 12 tables and 12 preformatted blocks. |

The detached test appended deterministic text without replacing the existing
rich subtree. Both variants finished at the same measured height.
Simple and rich appends also finished with equal item counts and total
heights. The pager retained all 10,000 source updates in each round.

The browser exposed roughly 1 ms timer resolution. Individual sub-millisecond
readings therefore include zeros. The table uses summed readings or batched
measurements, not a zero median as evidence of free work. There are three
independent browser sessions, not nine independent sessions.

Staging's frame cost explains why its latency result is insufficient:

| Component session | Baseline largest rich-stage refresh tick (ms) | 64-row prototype (ms) |
| --- | ---: | ---: |
| `run-HuTsuc` | 4.691 | 14.148 |
| `run-exiEAB` | 5.598 | 20.126 |
| `run-QtMB1E` | 4.203 | 16.029 |

Refresh ticks include browser work, not only the render callback.
The 20.126 ms tick contained 16 sampled stacks through the staged
measurement `append` path, including native reflow. Teardown ran in a later
frame. The layout warmup occurs after the loop's 3 ms budget check, so that
budget does not bound the whole staging frame.

Structural updates over 10,000 declared rows measured a median of 7 ms,
with an 11 ms maximum across 180 calls. No structural-consolidation variant
was tested, so no gain is claimed. The synthetic sticky-header test measured
5–8 ms per 2,000 refreshes with 100 keys. It used a simple position callback
and does not represent every host adapter.

## Corrections to the static hypotheses

The review identified real work but overstated several conclusions:

- Candidate 1 needs node reuse as well as retained connection. Removing only
  the final cleanup still leaves the next `replaceChildren` call. The tested
  variant bounded retention to one row. Resource loading, hidden descendants,
  accessibility, observer behavior, and lifecycle failures still need tests.
- Candidate 2 allocates five arrays for three pages, including the outer
  `pages.map` array. The cited September 13 captures predate `updateItemLive`.
  They cannot attribute their cycle-collection slice to this newer path.
- Candidate 3 excludes layout warmup from its render budget. The measured
  frame-cost increase disproves the claim that this budget alone protects
  heavy rows when the cap increases.
- Candidate 4 combines conditional paths. An idle structural `setItems`
  call does not also execute every listed mid-phase and `updateWindow` pass.
  Its table is not a per-commit execution count.
- Candidate 5 has a measurable but small component cost. No public revision
  field was added or tested. A revision-based cache also needs rules for
  host header changes and replaced inline elements.
- Candidate 6 does not allocate all three publication closures on every
  scroll event. State and viewport notifications are conditional. No current
  evidence connects those allocations to a scrolling collection pause.

## Reproduction and artifacts

Keep the source unchanged and prepare fresh copies before starting Vite:

> **Note:** These static-review scripts measured the original runtime and
> were removed when `virtual-list-next` replaced it (commit `aeeb778`
> onward). Check out an earlier revision to rerun them.

```sh
node scripts/firefox-profile/prepare-static-review.mjs
pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
```

In another terminal, use the generated directory name in both commands:

```sh
node scripts/firefox-profile/run-static-review.mjs static-review-EXAMPLE chat
node scripts/firefox-profile/run-static-review.mjs static-review-EXAMPLE components
```

The batch script calls `pnpm run profile:firefox` for each sequential capture.
It targets the LU28R55 and stops on a failed capture. Do not interact with
the profiling browser during native input. Stop the server that you started
after capture finishes.

Read each local capture without modifying it:

```sh
node scripts/firefox-profile/static-review-results.mjs browser-artifacts/firefox/run-EXAMPLE
node scripts/firefox-profile/attribute.mjs browser-artifacts/firefox/run-EXAMPLE --filter=/src/
```

All run IDs in this report identify local, ignored artifacts. Nothing was
uploaded. The exploratory baseline `run-eknK25` and component run
`run-D9WC7R` are not included in the paired tables. Failed launches
`run-xNh2gi` and `run-Kk4rXU` had unresolved copied dependencies or cached
CSS resolution errors. `run-hDkt3a` failed during native display enumeration,
before Firefox launched. None counts as performance evidence.

## Verification and next steps

The repository check, 928 unit tests, and 24 portable profiling checks passed
after adding the measurement scripts. All successful captures removed their
temporary browser profiles. The process audit found no remaining profiling browser or native
helper. The task-owned server on port 4193 was closed, while the existing
server on port 5173 remained untouched.

Only candidate 1 has a repeatable full-chat CPU gain in this investigation.
It still needs bounded-lifecycle, error-path, late-resource, and cross-browser
verification before implementation. Candidate 3 needs a different scheduling
design that accounts for layout cost. Candidates 2 and 4–6 remain unproven
as worthwhile production performance changes. No commit, push, tag, or
runtime patch is part of this report.
