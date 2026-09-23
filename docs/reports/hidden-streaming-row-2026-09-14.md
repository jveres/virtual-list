# Hidden streaming row: September 14, 2026

Bounded hidden-row retention reduces median Firefox content-thread CPU by
28.4% in the measured chat workload. The production patch passes lifecycle
and browser regressions without adding a public API. This follows the
[candidate measurements](runtime-candidate-measurements-2026-09-14.md), which
tested an isolated prototype before implementation.

## Implementation and lifecycle

The patch changes `src/premeasure.ts` against main revision `6fc4434`.
The synchronous measurer retains at most one successfully measured element
in its off-scroller root. Repeated measurement of that element preserves its
connection and layout tree. Each call still refreshes width, restores
runtime-owned positioning, and reads the current height.

A different single row replaces the resident. Larger batches and failed
measurements detach all elements. An empty batch leaves the resident alone.
Mounting moves the same element into its slot. Destruction removes it, and
disposal clears the root. There is no separate reference cache.

Measurement roots use `inert`, `aria-hidden`, hidden visibility, and zero
opacity. Opacity suppresses paint even when a descendant overrides visibility.
The attributes stay on the root, not on the row that later mounts.
The shared root helper also applies these protections to staged measurement.
Batch scheduling, paging, geometry publication, and scroll timers are unchanged.

Hosts use `onMount` and `onUnmount`, not `isConnected`, for mounted resources.
Hidden residents have no runtime ResizeObserver subscription. Late resources
still need stable dimensions or a host update. Mounting reconnects observation
and applies detected growth through the existing update policy.

## Native Firefox comparison

The six successful captures ran from 08:54 to 08:59 UTC on September 14.
They used installed Firefox 155.0.1 on the LU28R55 external display:
1920×1080 logical pixels, 2× scaling, 60 Hz, and 1900×965 browser content.
Each used a fresh temporary profile, closed DevTools, live profiling, and
no CPU or network throttling. CPU analysis ran after all captures.

The baseline was the preserved `6fc4434` source copy from the earlier
investigation. Patched runs loaded the actual working-tree demo, not the
prototype copy. The workload was the built-in fast long reply with fixed
8 ms midpoint token delays. Each run used 12 native upward gestures, 90 ticks
per gesture, 60 pixels per tick, 16.667 ms tick spacing, and 700 ms release
pauses. Warmup lasted 2 seconds before and after setup.

The table lists every successful run in execution order. Run IDs refer to
local, ignored captures under `browser-artifacts/firefox/`.

| Run | Version | Content CPU (ms) | Average CPU, one core (%) | Longest awake interval (ms) | Scroll handler p95 / max (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| `run-JTK6ub` | Baseline | 2,119.522 | 6.992 | 10.960 | 0.428 / 0.679 |
| `run-RQoVeH` | Patched | 1,517.763 | 4.967 | 14.215 | 0.440 / 0.760 |
| `run-654u1O` | Patched | 1,157.160 | 3.783 | 10.927 | 0.314 / 0.711 |
| `run-95wWFj` | Baseline | 2,359.740 | 7.931 | 14.228 | 0.456 / 0.786 |
| `run-JOr5Od` | Baseline | 2,063.049 | 6.765 | 11.808 | 0.378 / 1.197 |
| `run-Xe4FeC` | Patched | 1,755.395 | 5.927 | 12.002 | 0.529 / 1.075 |

Median CPU fell from 2,119.522 ms to 1,517.763 ms. Every patched run used
less CPU than every baseline run. Nearest-JavaScript samples attributed to
`measureMany` and its callbacks fell from 678–736 to 1–5. These samples include
native layout beneath JavaScript, not only JavaScript execution.

Every capture recorded 723–728 moving frames and scroll events, 13 scroll
ends, three scroll-position writes, and the same final geometry:
`scrollTop = 0`, `scrollHeight = 30959`. No animation-frame interval exceeded
25 ms. Per-run maxima ranged from 17.50 to 17.68 ms.

Peak work did not improve consistently. The median longest awake interval
rose from 11.808 to 12.002 ms. The largest refresh tick was 8.251 ms in the
baseline group and 9.772 ms in the patched group. The result supports a CPU
reduction, not a general spike fix or proof of smooth physical presentation.
Scripted native gestures do not replace real trackpad-momentum testing.

One launch, `run-NZ6sQH`, failed before measurement because macOS could not
focus the test Firefox window. It is excluded. The runner removed its
temporary profile, and the remaining sequence resumed with a fresh baseline.

## Correctness and limits

The repository check, 934 unit tests, and 24 portable profiling checks pass.
Six focused browser scripts pass: hidden measurement, dynamic resize,
Markdown streaming consumer, paged streaming consumer, basic streaming
consumer, and streaming height. The first five cover Firefox, Chromium,
and WebKit. Streaming-height checks cover Firefox with both cursor modes.

The new regression checks connected reuse without child-list mutations,
focus exclusion, role-query exclusion, late image decode, resize, mounting,
removal, and disposal. It also checks that hidden rows have no runtime resize
subscription and that disposal releases all subscriptions. Unit tests cover
batch eviction, empty batches, width and layout failures, recovery, positioning,
and disposal during measurement.

These correctness tests use Playwright engines, not installed Safari or the
installed Firefox used for performance. One preliminary standalone-consumer
run timed out. A repeat without source edits passed in all three engines.

WebKit's legacy `window.find()` can match a descendant that explicitly sets
`visibility: visible`, even inside the inert, transparent, aria-hidden root.
The same test cannot focus that descendant, and role queries exclude it.
Without the visibility override, scripted Find excludes it in all three
engines. The regression records this limitation rather than claiming uniform
Find behavior. Native browser Find UI and assistive-technology behavior were
not tested.

## Reproduction and cleanup

Follow the [Firefox workflow](../firefox-profiling.md). Preserve an unpatched
baseline with the preparation script before applying the production patch,
as described in the [earlier report](runtime-candidate-measurements-2026-09-14.md#reproduction-and-artifacts).
Start Vite on port 4193, then substitute that experiment directory name:

> **Note:** These static-review scripts measured the original runtime and
> were removed when `virtual-list-next` replaced it (commit `aeeb778`
> onward). Check out an earlier revision to rerun them.

```sh
node scripts/firefox-profile/run-static-review.mjs static-review-EXAMPLE current
```

The `current` mode runs baseline, patched, patched, baseline, baseline,
and patched captures. Baseline URLs use the preserved copy. Patched URLs use
`/demos/streaming/` from the working tree. Do not edit source during capture.
Use `static-review-results.mjs` to analyze the completed captures afterward.

All profiles, the generated production diff, and analysis output remain
local under ignored `browser-artifacts/`. Nothing was uploaded. The runner
removed all temporary browser profiles. The final process audit found no
task-owned browser, native helper, or automation session. The task-owned
port 4193 server was closed. The existing port 5173 server remained untouched.
