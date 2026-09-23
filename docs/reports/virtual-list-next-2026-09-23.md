# virtual-list-next verification: September 23, 2026

> **Note:** After this verification, `next` replaced the original runtime in
> `src/` on this branch, and the module swap, the parity exclusions, and the
> comparison benches were removed. Paths below point to the new locations.

This report records the verification of `virtual-list-next`, a replacement
for the runtime's orchestration layer, on branch `virtual-list-next` from
main `37a21e6`. The architecture and its rationale are in
[`docs/architecture.md`](../architecture.md). `next` keeps the physics modules of
`src/` unchanged and rebuilds `virtual-list.ts` around one commit rule, rows
measured where they mount, and a single pass for every entry point.

`next` also hands scroll anchoring to the engine where CSS scroll anchoring
is supported (F5), and keeps the runtime's settle-gated anchoring as the
fallback. The [native anchoring](#native-scroll-anchoring-f5) section covers
that mode.

On this evidence, `next` behaves like the current runtime:

- It passes 358 of the 384 tests in `src/`'s contract suite. The 26
  exclusions are intended changes.
- The chat invariants report no violations in Chromium, Firefox, or WebKit,
  with native or runtime anchoring. The dynamic-height lab reports none. Its
  page opts out of native anchoring, and the lab can't observe that mode.
- The feature regression suite finds no `next`-only failure (see
  [Regression suite](#regression-suite)).

The orchestration layer shrinks from 3,910 to 2,946 lines (−25%), or from
2,840 to 2,528 code lines (−11%). The first commit, before native anchoring
and the streaming paging fix, was 2,650 lines and 2,333 code lines (−32% and
−18%). Runtime CPU cost is within ±10% of
`main` in headless engines. Beyond the removed modes, two behaviors change
on purpose: DOM order now always follows list order, and with native
anchoring, changes above the reader land during a gesture.

## Scope and environment

All runs used headless Playwright engines against private Vite servers on
`127.0.0.1`, except one Chrome probe described under
[Limitations](#limitations). They are correctness and CPU evidence. They
aren't device or physical-smoothness evidence.

| Property | Value |
| --- | --- |
| Engines | Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6 (Playwright builds) |
| Host | macOS 27; Firefox launches with temporary `MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA` |
| `main` server | Default Vite config, separate dependency cache, port 4274 |
| `next` server | `vite.next.config.ts`, which swaps `src/virtual-list.ts` and `src/index.ts` for `next/`, port 4273, `auto` anchoring (native in all three engines) |
| `next` runtime-anchoring server | The same config with `VITE_VL_ANCHORING=runtime`, port 4275 |
| Demos | Unchanged; the module swap is the only difference |

Raw logs and benchmark JSON are kept locally under ignored
`browser-artifacts/next-2026-09-23/`.

## Contract parity

`vitest.next.config.ts` runs `tests/unit/virtual-list.test.ts` against `next`
with the harness default switched from `same-height` to `live`. The
exclusions are listed with reasons in
`next/tests/parity.ts` (removed with the swap; see commit `a752504`). To classify them, the
same live-default suite ran against `src/` as a control.

| Group | Tests | Why they're excluded |
| --- | ---: | --- |
| Pass on `next` | 358 | — |
| Old modes' held semantics | 15 | They fail on `src/` too once the harness is live. |
| Removed mode or option | 5 | They request `freeze`, `same-height`, or `prepareDuringScroll: false`. |
| Measurement root and wrapper release | 5 | They assert the detached root or wrapper recreation that `next` replaces. |
| Staging through in-place updates | 1 | It pins that an in-place item update cancels a staged page. `next` keeps staging and asks the updater again at the commit, adopting the staged rows. |

`tests/unit/virtual-list-foundation.test.ts` adds ten tests for `next`-specific behavior:

- No measurement root in `<body>`.
- Hidden, inert staging and reveal of the same slot.
- The offscreen resident row.
- The post-commit sweep.
- DOM order in both scroll directions.
- The one commit rule.
- The pass queue and host failure reporting.
- A paging-companion page landing while a reply streams a token every
  frame, with each page row rendered once.

`tests/unit/virtual-list-native.test.ts` adds seven tests for native anchoring.

`pnpm test` (1,085 tests) still passes, because `src/` is unchanged.

## Browser verification

The browser matrix and the regression suite ran against the `next` server.
Every failure was rerun against the `main` server with the same command.

### Product invariants

`scripts/chat-invariants.mjs` samples the row under a fixed viewport point
through loads, sends, and interactions. The dynamic-height lab counts
contract violations from outside the runtime. These runs predate F5, when
runtime anchoring was the only mode. The current revision's runs are in
[Native anchoring verification](#native-anchoring-verification).

| Suite | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Chat invariants | 0 violations, 0 errors | 0 violations, 0 errors | 0 violations, 0 errors |
| Lab, live mode, full scenario | 0 violations, 231 commits (30 live) | 0 violations, 223 commits (36 live) | 0 violations, 238 commits (27 live) |

The lab also reports zero clipped paints in every engine. Its `freeze` and
`same-height` modes don't apply to `next`, which has one commit rule.

### Regression suite

The full suite, 95 scripts in their existing engine coverage, ran on the
`next` server in `auto` mode, which anchors natively in all three engines.
It found one more defect: native anchoring overrode a scroller's own
`overflow-anchor: none` (see
[Native anchoring defects](#native-anchoring-defects)). That run had 84 passes.
After the fix, the three scripts it failed (`runtime/live-shrink`,
`runtime/dynamic-resize`, and `feed/feed`) pass. **87 pass.** None of the 8
remaining failures is specific to `next`:

| Script | On `main` | Cause |
| --- | --- | --- |
| `chat-editing/chat-version-toolbox` | Same failure | Toolbox spacing assertion (`bottom: -12`). |
| `chat-scrolling/chat-composer-resize` | Same failure | Firefox: "typing within the second line must not resize the composer." |
| `chat-scrolling/chat-scrollback` | Same failure | Predates idle page preparation becoming the default (`82c1e17`): "older rows are not prepared before the top glide lands." |
| `chat-storage/chat-refresh` | Same failure | Refresh button alignment assertion. |
| `chat-storage/chat-stop-reload` | Same failure | `turns.at is not a function` inside the test's own predicate. |
| `runtime/profiling-fixtures` | Same failure | Not investigated. |
| `runtime/streaming-trail` | Same failure | Not investigated. |
| `runtime/hidden-measurement` | Passes | Asserts the detached measurement root. `next` replaces it with its [hidden-row variant](../../scripts/regressions/runtime/hidden-row-regression.mjs), which passes in all three engines. |

The first run was on an earlier revision of `next`, before F5, and it found
the `provider-versions` and `chat-prepend-anchor` defects listed below. Both
pass on the final revision.

### Defects found and fixed

The first runs found these defects in `next`. Each was fixed, and the checks
that found it were rerun:

- **Older pages didn't load while a reply streamed.** The user found it in
  the streaming demo, in both directions. Each token replaces the streaming
  message in place, which invalidates a staged page, as the paging
  companion's contract requires. The companion retried, but every retry
  staged the page from scratch, and the next token cancelled it again, so
  pages loaded only once the stream stopped. A staged job now keeps staging
  through in-place updates, and at its commit asks the updater again for
  current data, adopting the rows it staged by item identity. The new page
  lands within a few tokens. A key-order change still cancels the job.
  [`scripts/regressions/runtime/stream-paging-regression.mjs`](../../scripts/regressions/runtime/stream-paging-regression.mjs)
  streams a token every 50 ms while an older page loads, and passes in all
  three engines. Without the fix, it times out with the page still loading,
  as does a unit test that streams a token every frame. The paging
  regressions rerun after the fix pass, except `chat-scrollback`, which
  fails the same way on `main`.

- **Hidden rows were findable and focusable.** A staged row with a
  `visibility: visible` descendant was reachable by `window.find` and focus.
  Hidden slots are now `inert` and `aria-hidden`, like the old measurement
  root. [`scripts/regressions/runtime/hidden-row-regression.mjs`](../../scripts/regressions/runtime/hidden-row-regression.mjs)
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
| `next`, first commit | 2,650 | 2,333 |
| `next` now: `virtual-list.ts`, `types.ts`, `index.ts` | 2,946 | 2,528 |
| Change from `main` | −25% | −11% |

Native anchoring (F5) is most of the growth since the first commit. A
cleanup pass after it removed 64 lines. The runtime path stays as the fallback,
so native anchoring doesn't yet remove code. Removing that path for engines
that anchor natively is the largest remaining reduction; see the
[architecture roadmap](../architecture.md#5-roadmap).

## CPU measurements

`next/bench/compare.mjs` (removed; see commit `a752504`) runs the same
workloads on both servers in the same browser. It alternates the order each
round and reports medians of 9 rounds. Rows carry heading, paragraph, code,
and list content. Firefox and WebKit report `performance.now()` in whole
milliseconds here, so their sub-3 ms rows can't resolve small differences.
These runs predate F5 and use runtime anchoring. Native anchoring's CPU cost
hasn't been measured.

| Workload | Chromium `main` → `next` | Firefox `main` → `next` | WebKit `main` → `next` |
| --- | --- | --- | --- |
| Boot 300 rows at the end | 33.7 → 35.4 ms (+5%) | 28 → 30 ms (+7%) | 38 → 41 ms (+8%) |
| Idle prepend of 60 offscreen rows | 12.8 → 13.6 ms (+6%) | 11 → 12 ms (+9%) | 15 → 16 ms (+7%) |
| Append 20 rows in view, following | 2.7 → 2.4 ms (−11%) | 3 → 3 ms | 3 → 3 ms |
| Scroll step, 240 px | 0.59 → 0.58 ms (−1%) | 0.48 → 0.43 ms (−10%) | 0.85 → 0.90 ms (+6%) |
| Streaming token into the last row | 0.61 → 0.58 ms (−4%) | 0.69 → 0.67 ms (−4%) | 0.87 → 0.83 ms (−4%) |

`next/bench/scrollback.mjs` (removed; see commit `a752504`) scrolls up
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

## Native scroll anchoring (F5)

After the first verification round, the user found that `next` felt no
smoother than `main` in real browsers, with minor jumps during mount and
unmount in all of them. `next` now uses CSS scroll anchoring where the
engine supports it, and falls back to the runtime's settle-gated anchoring
elsewhere. The design is in
[`docs/architecture.md`](../architecture.md#f5-native-scroll-anchoring-where-the-engine-has-it).
In short, a change above the reader lands during a gesture, and the engine,
not a script write, keeps the reader still. Edges, glides, and window jobs
with an explicit or end anchor keep the settle rule.

### Engine support

[`scripts/anchoring-probe.mjs`](../../scripts/anchoring-probe.mjs)
scrolls a plain flow list to 2,000 px. It then inserts 500 px above the
viewport and grows a row above it by 200 px, with no script scroll write.

| Engine | `overflow-anchor` supported | `scrollTop` after insert | After growth |
| --- | --- | ---: | ---: |
| Chromium 153 | Yes | 2,500 | 2,700 |
| Firefox 155 | Yes | 2,500 | 2,700 |
| WebKit 26.6 | Yes | 2,500 | 2,700 |

### Structural changes that suppress anchoring

CSS scroll anchoring skips its adjustment after some changes near the
anchor. The first native attempts lost adjustments, so
[`scripts/anchoring-structure-probe.mjs`](../../scripts/anchoring-structure-probe.mjs)
measures each structural change of the native surface. Each case adds 300 px
above the reader, with no script scroll write. The table shows how far each
engine moved `scrollTop` on its own. 300 means it anchored, and 0 means the
change suppressed anchoring:

| Change above the reader | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| Top spacer grows | 300 | 300 | 300 |
| Slot inserted above | 300 | 300 | 300 |
| Slot above grows | 300 | 300 | 300 |
| Zero-height staged slot revealed by height | 300 | 300 | 300 |
| Absolute staged slot revealed in flow | 0 | 0 | 0 |
| Hidden absolute slot removed, spacer grows | 300 | 300 | 300 |
| Canvas `min-height` changes, spacer grows | 0 | 0 | 0 |
| Slot of a partly visible row replaced, spacer grows | 300 | 300 | 300 |

The native surface uses only the changes that anchor. Staged slots wait in
flow at zero height and are revealed by height alone. A mid-gesture commit
leaves the canvas `min-height` alone. It also keeps the current window
mounted: an earlier revision mounted the new window first, and Firefox lost
the adjustment when a page landed.

### Native anchoring verification

These runs used the servers in [Scope and environment](#scope-and-environment).
The `auto` rows for the chat invariants and the regressions ran after the
last runtime change. The `auto` lab rows ran before the
[streaming paging fix](#defects-found-and-fixed), which only changes window
jobs whose source is updated in place. The runtime-server rows ran before
the two fixes below. Neither changes a list in runtime mode: the glide fix
only applies to native anchoring, and the detection fix only decides the
mode.

| Check | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Chat invariants, `auto` (native) | 0 violations, 0 errors | 0 violations, 0 errors | 0 violations, 0 errors |
| Chat invariants, runtime server | 0 violations, 0 errors | 0 violations, 0 errors | 0 violations, 0 errors |
| Lab, live mode, `auto` (the page opts out) | 0 violations, 229 commits (29 live) | 0 violations, 217 commits (31 live) | 0 violations, 243 commits (31 live) |
| Lab, live mode, runtime server | 0 violations, 238 commits (36 live) | 0 violations, 243 commits (39 live) | 0 violations, 250 commits (35 live) |
| [Native anchoring regression](../../scripts/regressions/runtime/native-anchoring-regression.mjs) | Passes | Passes | Passes |
| [Native glide regression](../../scripts/regressions/runtime/native-glide-regression.mjs) | Passes | Passes | Passes |
| [Hidden-row regression](../../scripts/regressions/runtime/hidden-row-regression.mjs) | Passes | Passes | Passes |
| [Stream-paging regression](../../scripts/regressions/runtime/stream-paging-regression.mjs) | Passes | Passes | Passes |

The lab reports zero clipped paints in every run.

The native anchoring regression holds a synthetic gesture at `scrollTop` 400
while an older page lands. In every engine, the engine moves `scrollTop`
from 400 to 2,956 with zero script scroll writes, and the row under the
reader drifts by at most 1 px.

The lab can't observe native mode. It infers slot geometry from each slot's
`translateY` offset and `height` style, and it flags any change above the
viewport during a scroll. Native slots have no offset, and changes above the
viewport during a scroll are the point of F5. Before the detection fix, the
lab ran in native mode and reported 1,041 violations in Chromium, all from
this mismatch: spacers counted as rows without a key, and staged
zero-height slots counted as clipped rows. Staged rows don't paint. The
lab's page sets `overflow-anchor: none`, so it now runs with runtime
anchoring on every server.

`tests/unit/virtual-list-native.test.ts` pins the surface and the commit rule in jsdom.

### Native anchoring defects

- **Native anchoring overrode the host's opt-out.** Detection set the
  scroller's `overflow-anchor` to `auto` before it read the computed value,
  so it never saw a host's `overflow-anchor: none`. The feed, gallery, lab,
  and scroll-settle demos all set it. The regression suite found it through
  `runtime/live-shrink`, whose fixture opts out. `auto` now reads the
  computed value first, and only an explicit `anchoring: "native"`
  overrides it. A unit test fails without the fix.
- **"Scroll to top" loaded the whole history.** The user found it in the
  streaming demo on `dev:next`. A glide toward the start let the older page
  commit mid-glide. The engine anchored it, and the glide then continued to
  the new start, reached it, and loaded the next page, until the first page
  landed. One press loaded 8 pages in Chromium and ended at `scrollTop` 0.
  A glide now keeps the settle rule, as on `main`. One press loads one page
  in every engine and leaves the reader on the old first row
  (`scrollTop` 5,120), as runtime mode does. The native glide regression
  and a unit test fail without the fix.

## Suite cleanup after the restructure

After `next` replaced the runtime in `src/`, the seven regression scripts
that also failed on `main` were reviewed one by one. Each is now expected to
pass. Two were real bugs:

| Script | Finding | Change |
| --- | --- | --- |
| `chat-storage/chat-stop-reload` | Stale test: history is stored as `{ turns, tree }` since the conversation tree | Its predicate reads both shapes. |
| `chat-storage/chat-refresh` | Stale geometry from before the shared footer (4 px gap) | Expects the footer's 16 px gap. |
| `chat-editing/chat-version-toolbox` | Stale geometry: expected the toolbar flush with the message bottom | Expects the footer's 12 px of breathing room. |
| `chat-scrolling/chat-composer-resize` | Real bug: in Firefox the composer grew by 1 px while typing within a line, because `scrollHeight` is rounded differently for an empty last line | `integrations/composer.ts` snaps overflowing text to the line grid; the composer is 66.8 px in every engine. |
| `chat-scrolling/chat-scrollback` | Obsolete assertion: forbade preparing older rows during the top glide, which idle page preparation does by design | Assertion removed; the prepend and date-pill checks stay. |
| `runtime/streaming-trail` | Pinned to `markdown-viewer` v0.2.5: in-cell edits and DOM mutations no longer start a trail in v0.5.0 | Rewritten for the append-driven trail; coverage, fades, bounds, reduced motion, and cleanup stay. |
| `runtime/profiling-fixtures` | Real bug: under a fast stream in Firefox, a token commit judged the lagging follow glide by position and dropped following | While a follow glide runs, an `auto` commit captures the end. |
| `chat-content/chat-image-reconcile` | Flaky under load: an image `load` event dispatched after `decode()` resolved and landed in a measured window | The test waits for both images' `load` events. |

`runtime/dynamic-resize` now runs the lab's one remaining mode, and
`runtime/hidden-measurement` was replaced by `runtime/hidden-row`.

The final full run of the 98 scripts, after all of these changes, passed 97.
The one failure was `chat-image-reconcile`, which ran before its load-race
fix; rerun through the runner, it passes. Chat invariants report 0
violations in Chromium, Firefox, and WebKit, and `pnpm test` passes 1,050
tests.

## Limitations

The evidence has these gaps:

- No profile or device run. Real Firefox, Safari, and iOS smoothness remain
  unverified for `next`, in both anchoring modes. The native-anchoring
  evidence is synthetic: a held wheel phase in Playwright engines, not
  momentum or a rubber-band bounce.
- The user saw Chrome scrolling on `dev:next` pause for hundreds of
  milliseconds, then resume with the same momentum, on every display.
  Temporary `?debug-scroll-tasks` tracing showed an idle page main thread in
  every pause, with no runtime or idle-callback work. The pauses happened
  while this report's test batches and engine edits (which reload the page)
  ran on the same machine. On a quiet machine, the user saw none. An
  isolated installed Chrome with synthetic native momentum (16 gestures,
  two of them landing a page) didn't reproduce it either. The tracing was
  removed.
- The lab can't observe native anchoring.
- With `anchoring: "native"` forced, `feed/feed` fails its retry phase in
  WebKit. Its scripted jump to the end doesn't reach the end reach zone, so
  the failing request never happens. In `auto` mode the feed opts out, and
  the script passes. Not investigated further.
- In native mode, a declared row whose render throws inside the window
  leaves no hole: the flow closes up, and the rows below it shift until the
  render is retried. Runtime mode leaves the hole in place.
- The CPU benchmarks are headless, synthetic, and short. They don't measure
  presentation, compositing, or GPU work.
- The lab ran only its live mode, with runtime anchoring.
- The pre-existing regression failures also fail on `main`. Their causes
  were not investigated.

## Next steps

These follow-ups remain before `next` could replace `src/`:

1. Compare `pnpm run dev:next` (native anchoring) with
   `pnpm run dev:next:runtime` by hand in Firefox, Chrome, desktop
   Safari 27, and on the iPad and iPhone: mount and unmount during
   scrollback, the top edge, sends with pinning, and gallery masonry.
2. Run the Firefox-first native profile on the LU28R55 display against the
   `main`, native, and runtime servers, using the idle-page-preparation
   workload for a comparable baseline.
3. Decide on the API trims and the research tracks listed in
   [`docs/architecture.md`](../architecture.md#5-roadmap).
