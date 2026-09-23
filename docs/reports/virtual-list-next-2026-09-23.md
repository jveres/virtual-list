# virtual-list-next verification: September 23, 2026

This report records the verification of `virtual-list-next`, a replacement
for the runtime's orchestration layer, on branch `virtual-list-next` from
main `37a21e6`. The architecture and its rationale are in
[`next/README.md`](../../next/README.md). `next` keeps the physics modules of
`src/` unchanged and rebuilds `virtual-list.ts` around one commit rule, rows
measured where they mount, and a single pass for every entry point.

On this evidence, `next` behaves like the current runtime:

- It passes 359 of the 384 tests in `src/`'s contract suite. The 25
  exclusions are intended changes.
- The chat invariants and the dynamic-height lab report no violations in
  Chromium, Firefox, or WebKit.
- The feature regression suite finds no `next`-only failure (see
  [Regression suite](#regression-suite)).

The orchestration layer shrinks from 3,910 to 2,650 lines (−32%), or from
2,840 to 2,333 code lines (−18%). Runtime CPU cost is within ±10% of `main`
in headless engines. Beyond the removed modes, one behavior changes on
purpose: DOM order now always follows list order.

## Scope and environment

All runs used headless Playwright engines against private Vite servers on
`127.0.0.1`. They are correctness and CPU evidence. They aren't native-input,
installed-browser, device, or physical-smoothness evidence.

| Property | Value |
| --- | --- |
| Engines | Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6 (Playwright builds) |
| Host | macOS 27; Firefox launches with temporary `MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA` |
| `main` server | Default Vite config, separate dependency cache, port 4274 |
| `next` server | `vite.next.config.ts`, which swaps `src/virtual-list.ts` and `src/index.ts` for `next/`, port 4273 |
| Demos | Unchanged; the module swap is the only difference |

Raw logs and benchmark JSON are kept locally under ignored
`browser-artifacts/next-2026-09-23/`.

## Contract parity

`vitest.next.config.ts` runs `tests/unit/virtual-list.test.ts` against `next`
with the harness default switched from `same-height` to `live`. The
exclusions are listed with reasons in
[`next/tests/parity.ts`](../../next/tests/parity.ts). To classify them, the
same live-default suite ran against `src/` as a control.

| Group | Tests | Why they're excluded |
| --- | ---: | --- |
| Pass on `next` | 359 | — |
| Old modes' held semantics | 15 | They fail on `src/` too once the harness is live. |
| Removed mode or option | 5 | They request `freeze`, `same-height`, or `prepareDuringScroll: false`. |
| Measurement root and wrapper release | 5 | They assert the detached root or wrapper recreation that `next` replaces. |

`next/tests/foundation.test.ts` adds nine tests for `next`-specific behavior:

- No measurement root in `<body>`.
- Hidden, inert staging and reveal of the same slot.
- The offscreen resident row.
- The post-commit sweep.
- DOM order in both scroll directions.
- The one commit rule.
- The pass queue and host failure reporting.

`pnpm test` (1,085 tests) still passes, because `src/` is unchanged.

## Browser verification

The browser matrix and the regression suite ran against the `next` server.
Every failure was rerun against the `main` server with the same command.

### Product invariants

`scripts/chat-invariants.mjs` samples the row under a fixed viewport point
through loads, sends, and interactions. The dynamic-height lab counts
contract violations from outside the runtime. Both ran after the last runtime
change.

| Suite | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Chat invariants | 0 violations, 0 errors | 0 violations, 0 errors | 0 violations, 0 errors |
| Lab, live mode, full scenario | 0 violations, 231 commits (30 live) | 0 violations, 223 commits (36 live) | 0 violations, 238 commits (27 live) |

The lab also reports zero clipped paints in every engine. Its `freeze` and
`same-height` modes don't apply to `next`, which has one commit rule.

### Regression suite

The full suite, 95 scripts in their existing engine coverage, ran on `next`
after the last runtime change. **87 pass.** None of the 8 failures is
specific to `next`:

| Script | On `main` | Cause |
| --- | --- | --- |
| `chat-editing/chat-version-toolbox` | Same failure | Toolbox spacing assertion (`bottom: -12`). |
| `chat-scrolling/chat-composer-resize` | Same failure | Firefox: "typing within the second line must not resize the composer." |
| `chat-scrolling/chat-scrollback` | Same failure | Predates idle page preparation becoming the default (`82c1e17`): "older rows are not prepared before the top glide lands." |
| `chat-storage/chat-refresh` | Same failure | Refresh button alignment assertion. |
| `chat-storage/chat-stop-reload` | Same failure | `turns.at is not a function` inside the test's own predicate. |
| `runtime/profiling-fixtures` | Same failure | Not investigated. |
| `runtime/streaming-trail` | Same failure | Not investigated. |
| `runtime/hidden-measurement` | Passes | Asserts the detached measurement root. `next` replaces it with its [hidden-row variant](../../next/regressions/hidden-row-regression.mjs), which passes in all three engines. |

The first run was on an earlier revision of `next`, and it found the
`provider-versions` and `chat-prepend-anchor` defects listed below. Both
pass on the final revision.

### Defects found and fixed

The first runs found these defects in `next`. Each was fixed, and the checks
that found it were rerun:

- **Hidden rows were findable and focusable.** A staged row with a
  `visibility: visible` descendant was reachable by `window.find` and focus.
  Hidden slots are now `inert` and `aria-hidden`, like the old measurement
  root. [`next/regressions/hidden-row-regression.mjs`](../../next/regressions/hidden-row-regression.mjs)
  covers this in all three engines.
- **Swept rows kept their inert state.** A staged row detached by the sweep
  kept `inert` when it later mounted.
- **Hidden rows answered rect queries.** A hidden slot sat at the canvas
  top, so near `scrollTop` 0 its row's box overlapped the viewport. The
  `chat-prepend-anchor` script then chose a hidden row as the visible
  reading row. Hidden slots now wait 100,000 px above the scroll origin,
  unreachable and outside the scroll range.
- **DOM order diverged from list order.** A revealed slot stayed where it was
  staged, so the latest reply could precede an earlier one in the DOM, and
  `provider-versions` failed. Slots now join the canvas next to their
  nearest connected list neighbor. `src/` doesn't guarantee this either: it
  appends rows entering from above after the rows below them.
- **A window job's `onCommit` failure leaked** to the enclosing pass instead
  of rejecting the job's promise.
- **Positioned cards re-rendered mid-gesture** in their old boxes. Mid-phase,
  positioned rows now re-render inside the settle commit.
- **Targeted declared updates were O(n)**, with 30,032 `height()` calls for
  three updates of a 10,000-row list. They now make three calls.
- **A failed batched measurement left rows connected.** They're now
  detached.

## Code size

Lines are physical lines. Code lines exclude blank and comment-only lines. The
physics modules (`scroll-settle`, `wheel-policy`, `geometry`, `fenwick`,
`positioned-geometry`, `glide`, `follow`, `reach`, `viewport-repaint`) are
shared and unchanged: 1,843 code lines.

| Orchestration layer | Lines | Code lines |
| --- | ---: | ---: |
| `main`: `virtual-list.ts`, `snapshot.ts`, `render-state.ts`, `premeasure.ts` | 3,910 | 2,840 |
| `next`: `virtual-list.ts`, `types.ts`, `index.ts` | 2,650 | 2,333 |
| Change | −32% | −18% |

## CPU measurements

[`next/bench/compare.mjs`](../../next/bench/compare.mjs) runs the same
workloads on both servers in the same browser. It alternates the order each
round and reports medians of 9 rounds. Rows carry heading, paragraph, code,
and list content. Firefox and WebKit report `performance.now()` in whole
milliseconds here, so their sub-3 ms rows can't resolve small differences.
These runs predate the last change, which parks hidden slots with a
different `top` value in the same style string.

| Workload | Chromium `main` → `next` | Firefox `main` → `next` | WebKit `main` → `next` |
| --- | --- | --- | --- |
| Boot 300 rows at the end | 33.7 → 35.4 ms (+5%) | 28 → 30 ms (+7%) | 38 → 41 ms (+8%) |
| Idle prepend of 60 offscreen rows | 12.8 → 13.6 ms (+6%) | 11 → 12 ms (+9%) | 15 → 16 ms (+7%) |
| Append 20 rows in view, following | 2.7 → 2.4 ms (−11%) | 3 → 3 ms | 3 → 3 ms |
| Scroll step, 240 px | 0.59 → 0.58 ms (−1%) | 0.48 → 0.43 ms (−10%) | 0.85 → 0.90 ms (+6%) |
| Streaming token into the last row | 0.61 → 0.58 ms (−4%) | 0.69 → 0.67 ms (−4%) | 0.87 → 0.83 ms (−4%) |

[`next/bench/scrollback.mjs`](../../next/bench/scrollback.mjs) scrolls up
through a 60-row page just committed above the reader. Its median step is
0.54 → 0.48 ms in Chromium (−12%), 0.398 → 0.394 ms in Firefox, and 0.877 →
0.903 ms in WebKit.

The measurements support these conclusions:

- **Rows that land in view are cheaper in Chromium.** A revealed slot needs
  no second layout or re-parenting, and remounted rows keep their wrapper.
  Firefox and WebKit show no consistent difference at their timer
  resolution.
- **Large offscreen batches cost slightly more.** At boot or on an offscreen
  prepend, `next` stages every row in its own inert slot and detaches the
  offscreen ones afterwards. A boot-only run in Chromium attributes about
  0.3 ms per 300 rows to `inert` and 0.26 ms to the detach, out of a 1.1 ms
  gap (11.1 → 12.2 ms).
- **Keeping staged rows near the viewport laid out doesn't pay.** An
  experiment that kept them for one viewport past the overscan measured the
  same scrollback step as detaching them. It exposed hidden rows to host DOM
  queries, so it was reverted.

## Native scroll anchoring probe

[`next/bench/anchoring-probe.mjs`](../../next/bench/anchoring-probe.mjs)
scrolls a plain flow list to 2,000 px. It then inserts 500 px above the
viewport and grows a row above it by 200 px, with no script scroll write.

| Engine | `overflow-anchor` supported | `scrollTop` after insert | After growth |
| --- | --- | ---: | ---: |
| Chromium 153 | Yes | 2,500 | 2,700 |
| Firefox 155 | Yes | 2,500 | 2,700 |
| WebKit 26.6 | Yes | 2,500 | 2,700 |

All three engines compensate natively at rest. The probe says nothing about
compensation under momentum, at an overscrolled edge, or on iOS, which the
research track in the README must establish first.

## Limitations

The evidence has these gaps:

- No native input, trackpad momentum, installed browser, or device run. Real
  Firefox, Chrome, Safari, and iOS smoothness remain unverified for `next`.
- The CPU benchmarks are headless, synthetic, and short. They don't measure
  presentation, compositing, or GPU work.
- The lab ran only its live mode.
- The pre-existing regression failures also fail on `main`. Their causes
  were not investigated.

## Next steps

These follow-ups remain before `next` could replace `src/`:

1. Run the Firefox-first native profile on the LU28R55 display against both
   servers, using the idle-page-preparation workload for a comparable
   baseline.
2. Check `next` by hand in desktop Safari 27 and on the iPad and iPhone:
   chat scrollback at the top edge, sends with pinning, and gallery
   masonry.
3. Decide on the API trims and the research tracks listed in
   [`next/README.md`](../../next/README.md#5-roadmap).
