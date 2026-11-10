# Runtime and companion hot-path audit, November 10, 2026

This audit profiles the core runtime and companions at `f18b0c6` (`v0.7.0`),
evaluates candidate hot-path changes with interleaved A/B measurements, keeps
only repeatable improvements in Firefox, and discards sub-threshold candidates.
In Firefox 157.0, live paging edits get 93% faster, declared history prepends
51% faster, positioned boots 45% faster, declared boots 30% faster, positioned
item updates and page appends 28–29% faster, declared page appends 27% faster,
paging loads with budget trims 24% faster, mid-list declared changes 22% faster,
sticky-header scrolling and refreshes 20% faster, positioned relayouts 18%
faster, measured prepends and appends 13–15% faster, unchanged `setItems` 13%
faster, declared relayouts and single-item updates 12% faster, and measured
branch switches 10% faster. Streaming, scroll-window reconciliation, and width
resize stay bound by browser DOM mutations and required single-pass layout reads.

## Conditions

Initial hotspot attribution ran in the installed Firefox 157.0.1 (Gecko Profiler
via WebDriver BiDi in a fresh temporary profile with closed DevTools, on macOS
27.2 `26B123`, `LU28R55` `2560x1440` at `2x` scaling) alongside headless
Chromium 156.0.8078.4 CDP CPU sampling (50 µs interval).

Interleaved A/B comparisons ran in Playwright Firefox 157.0 (primary target,
`privacy.reduceTimerPrecision=false`) and headless Chromium 156.0.8078.4
(control) on the same machine (`1280x900` headless viewport). Each browser loads
the baseline runtime (`f18b0c6`) and the working tree side by side in one page
and alternates their execution order across 12 measured rounds after 2 warm-up
rounds. Three independent trials ran per browser.

The A/B workloads are synthetic and headless: they measure JavaScript and
synchronous layout without paint, native input, or physical presentation. They
make no claim about display-synchronized smoothness or native trackpad momentum.

## Profile findings and kept changes

| Hotspot | Cost at `f18b0c6` | Change |
| --- | --- | --- |
| `preparePositioned` + `PositionedGeometry` allocated 10,000 `{ top, lane, height }` objects, shifted edge slots with `unshift`, and hashed every lane into a `Map` on each snapshot (`src/virtual-list.ts`, `src/positioned-geometry.ts`). | ~15 ms of a 53 ms positioned append batch in Firefox | `DeclaredItems.columns()` exposes snapshot columns directly; `preparePositioned` populates pre-sized `Float64Array` columns in place, and `PositionedGeometry.fromColumns` buckets integer lanes `< 64` in a dense array (falling back to `Map` for sparse lanes `>= 64`). |
| `[...array]` copies in `KeyIndex`, `DeclaredItems`, and `virtual-list.ts` invoked SpiderMonkey's self-hosted `ArrayIterator.next` per element (`src/key-index.ts`, `src/declared-items.ts`, `src/virtual-list.ts`). | 219 native Gecko leaf samples in `append-positioned` | Replaced spread copies on dense arrays with `.slice()`, adopted pre-allocated owned key arrays via `KeyIndex.fromOwned` / `extend(keys, true)`, and cached `devicePixelRatio` once per synchronous `pass()`. |
| `indexItems` allocated a throwaway `Set<string>` on boot or prefix divergence, and `new KeyIndex(keys)` hashed every key a second time into a new `Map` (`src/virtual-list.ts`, `src/key-index.ts`). | ~45 ms of a 90 ms declared prepend batch and ~15 ms of a 34 ms positioned boot in Firefox | `indexItems` pre-sizes `keys` (including edge slots), short-circuits `isSlotKey` via `charCodeAt(0) === 0`, and builds the owned `Map<string, number>` directly in one pass on boot or non-append divergence. |
| `Geometry.setKeys` probed `this.order.get(key)` for every key when prepending, head-trimming, or splicing (`src/geometry.ts`). | ~4 ms across 30 prepends of 10,000 keys in Firefox | Added a sequential-run `hint` cursor (`oldKeys[hint] === key`) before falling back to `this.order.get(key)`, turning shifted contiguous runs into array comparisons while keeping exact learned heights and estimator call order. |
| `createPagedWindow` ran linear `findIndex` scans + `items.map` in `updateItem` / `updateItemLive`, and rebuilt `new Map(items.map(...))` tuples across `apply` and `load` (`src/paging.ts`). | 28.5 ms for 200 live edits over 4,000 retained rows; ~30 ms overhead in overlapping page loads/trims | Indexed incoming pages once (`keys` + `indexByKey`) and maintained `itemIndexByKey: Map<string, number>` (cleared on `dispose()`), turning live item replacement into O(1) + O(pages) map lookups and `.slice()`. |
| `createStickyHeaders.refresh()` allocated `flatMap` objects and three parallel arrays on every `onState` callback even when header boxes were unchanged, and `hideInlineFor` allocated filtered arrays per handoff step (`src/companions/sticky-headers.ts`). | ~7.8 ms across 600 scroll steps + 40 refreshes in Firefox | `refresh()` compares against existing columnar header boxes in place and allocates replacement buffers only when a header key, ordinal, or box changes; `hideInlineFor` tracks `hiddenActive` and `hiddenIncoming` as scalars. |
| `commitBody` unconditionally re-wrote `canvas.style.height` and re-read `viewport.scrollTop` in `reconcileAndPublish()` even when `!native`, scroll position did not move, and no host hooks ran (`src/virtual-list.ts`). | 737 of 1,805 Gecko samples (41%) in `update-declared` from a second synchronous layout flush per height edit | Guarded unchanged `canvas.style.height` writes in `syncCanvasHeight` and reused `before` in `reconcileAndPublish` when `!native`, scroll position is steady within `[0, maxScrollTop]`, and no host callbacks ran during `commitBody`. |
| `DeclaredItems.get(key)` probed `data.index.get(key)` twice (`itemOf` + `heightOf`) on every declared row materialization (`src/declared-items.ts`). | Double map lookup per newly mounted declared row | Consolidated snapshot lookup in `DeclaredItems.get(key)` to a single index probe. |

## Candidates evaluated and not kept

- **Indexed `DeclaredItems.heightAt` / `itemAt` bypass in `materialize` and `mountRow` (evaluated and reverted).** Threading `knownIndex` through `materialize` and `mountRow` to skip `declaredItems.get(key)` and `geometry.indexOf(row.key)` during scroll window sweeps improved `scroll-declared` by <1.5% (~0.3 ms across 600 scroll events) and left `scroll-native` / `scroll-runtime` unchanged (+0.3% / +1.3%), because scroll sweeps spend >95% of their time in browser DOM insertion, removal, and style updates. Reverted to keep the window-mounting path minimal.
- **Skipping `selectPin` tail scans in `updateItem`.** `pinning.match` is documented and tested with stateful predicates evaluated in reverse source order on `updateItem`; caching or skipping predicate calls would violate that contract.
- **Streaming `updateItem` layout reads (`stream-*`).** Post-optimization Gecko and Chromium profiles show that streaming updates spend their time in `renderInto` (host DOM text mutation) plus the single required `getBoundingClientRect()` read per token (~48 µs/token total in Firefox). No redundant layout read remains.
- **Positioned `updateItem` full re-placement (`update-positioned*`).** Positioned lists intentionally re-run `position(item)` across the snapshot on `updateItem` because responsive and masonry hosts share cross-item column state. Columnar `preparePositioned` + `PositionedGeometry.fromColumns` already reduced `update-positioned` by 28.5% and `update-positioned-move` by 29.3% while preserving that contract.

## Interleaved comparison

Each cell is the median of 12 alternating rounds, in milliseconds, baseline
(`f18b0c6`) to candidate. The delta column is the median of the three trial
deltas. Bold deltas mark paths directly targeted by the changes above; the
remaining rows serve as controls.

Firefox 157.0:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 200 live edits, 4,000 paged rows (`paging-live-edit`) | 28.52 → 1.86 | 28.20 → 1.94 | 28.50 → 2.00 | **-93.1%** |
| 30 prepends of 40 to 10,000 declared rows (`prepend-declared`) | 90.10 → 43.78 | 89.66 → 46.02 | 91.08 → 44.80 | **-50.8%** |
| 10 boots of 10,000 positioned cards (`boot-positioned`) | 32.48 → 18.66 | 35.20 → 18.88 | 33.62 → 18.64 | **-44.6%** |
| 10 boots of 20,000 declared rows (`boot-declared`) | 54.42 → 30.74 | 49.90 → 35.90 | 53.38 → 37.14 | **-30.4%** |
| 50 moving card edits, 5,000 positioned cards (`update-positioned-move`) | 22.50 → 16.04 | 22.44 → 15.86 | 23.50 → 15.78 | **-29.3%** |
| 50 in-place card edits, 5,000 positioned cards (`update-positioned`) | 22.32 → 15.96 | 22.56 → 15.76 | 21.52 → 15.86 | **-28.5%** |
| 40 pages appended to 5,000 positioned cards (`append-positioned`) | 53.20 → 38.54 | 53.50 → 39.30 | 53.40 → 37.80 | **-27.6%** |
| 50 pages of 40 appended to 10,000 declared rows (`append-declared`) | 32.04 → 21.38 | 29.80 → 21.96 | 29.48 → 21.66 | **-26.5%** |
| Overlapping page loads, jumps, and trims (`paging-load-trim`) | 123.72 → 91.88 | 119.90 → 95.46 | 120.76 → 92.18 | **-23.7%** |
| 50 mid-list height changes, 10,000 declared rows (`midlist-declared`) | 19.92 → 15.40 | 19.64 → 15.24 | 19.56 → 15.18 | **-22.4%** |
| 600 scroll steps + 40 sticky refreshes (`sticky-headers`) | 39.64 → 31.84 | 39.12 → 31.48 | 39.48 → 31.60 | **-19.7%** |
| 20 column-count relayouts, 5,000 positioned cards (`relayout-positioned`) | 26.06 → 21.26 | 25.86 → 21.28 | 25.46 → 21.24 | **-17.7%** |
| 30 prepends of 20 measured rows (`prepend-measured`) | 19.44 → 16.46 | 19.08 → 16.14 | 19.02 → 16.12 | **-15.3%** |
| 100 appends to 2,000 measured rows (`append-measured`) | 28.20 → 24.48 | 27.72 → 23.88 | 27.64 → 23.98 | **-13.2%** |
| 50 unchanged `setItems`, 5,000 measured rows (`setitems-same`) | 24.46 → 21.26 | 24.20 → 20.80 | 24.10 → 21.10 | **-13.1%** |
| 20 full relayouts, 10,000 declared rows (`relayout-declared`) | 18.24 → 15.96 | 18.10 → 15.96 | 18.24 → 16.00 | **-12.3%** |
| 300 single-item edits, 10,000 declared rows (`update-declared`) | 27.50 → 24.10 | 27.32 → 24.02 | 27.26 → 24.04 | **-12.1%** |
| 40 branch switches, 2,000 measured rows (`branch-switch-measured`) | 62.44 → 56.06 | 60.96 → 55.76 | 61.94 → 55.18 | **-10.2%** |
| 600 scroll steps, positioned cards (`scroll-positioned`) | 11.90 → 11.78 | 12.12 → 11.54 | 11.92 → 11.64 | -2.3% |
| 10 boots of 2,000 measured rows (`boot-measured`) | 27.50 → 27.14 | 27.08 → 26.72 | 27.08 → 26.40 | -1.3% |
| 600 streamed updates, runtime anchoring (`stream-runtime`) | 30.34 → 29.76 | 30.08 → 29.84 | 30.32 → 30.18 | -0.8% |
| 600 streamed updates, native anchoring (`stream-native`) | 29.18 → 29.26 | 29.12 → 29.02 | 29.46 → 29.22 | -0.3% |
| 600 scroll steps, runtime anchoring (`scroll-runtime`) | 28.70 → 28.56 | 28.10 → 28.02 | 28.02 → 28.18 | -0.3% |
| 600 streamed updates, chat options (`stream-chat-options`) | 29.08 → 29.04 | 29.10 → 29.02 | 29.14 → 29.30 | -0.1% |
| 600 scroll steps, native flow (`scroll-native`) | 29.32 → 29.32 | 30.02 → 29.84 | 29.58 → 29.88 | 0.0% |
| Two-tier width resize, 1,200 measured rows (`width-resize`) | 395.50 → 395.36 | 395.46 → 395.40 | 395.40 → 395.42 | 0.0% |
| 600 scroll steps, declared rows (`scroll-declared`) | 20.56 → 21.62 | 20.10 → 20.26 | 20.24 → 20.24 | +0.8% |

Chromium 156.0.8078.4:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 200 live edits, 4,000 paged rows (`paging-live-edit`) | 18.50 → 1.00 | 18.40 → 0.80 | 18.40 → 0.80 | **-95.7%** |
| 30 prepends of 40 to 10,000 declared rows (`prepend-declared`) | 34.20 → 22.50 | 34.50 → 22.40 | 34.40 → 22.80 | **-34.2%** |
| 300 single-item edits, 10,000 declared rows (`update-declared`) | 19.00 → 14.50 | 18.80 → 14.60 | 19.00 → 14.60 | **-23.2%** |
| Overlapping page loads, jumps, and trims (`paging-load-trim`) | 60.70 → 45.90 | 58.70 → 46.30 | 59.60 → 45.90 | **-23.0%** |
| 10 boots of 10,000 positioned cards (`boot-positioned`) | 14.80 → 11.80 | 15.00 → 11.10 | 14.60 → 11.70 | **-20.3%** |
| 50 moving card edits, 5,000 positioned cards (`update-positioned-move`) | 15.30 → 12.20 | 15.10 → 12.00 | 15.20 → 12.30 | **-20.3%** |
| 10 boots of 20,000 declared rows (`boot-declared`) | 21.90 → 17.70 | 21.70 → 17.90 | 23.50 → 16.50 | **-19.2%** |
| 600 scroll steps + 40 sticky refreshes (`sticky-headers`) | 29.10 → 24.50 | 28.00 → 23.70 | 28.20 → 24.40 | **-15.4%** |
| 50 in-place card edits, 5,000 positioned cards (`update-positioned`) | 13.70 → 11.80 | 13.60 → 11.80 | 13.60 → 12.10 | **-13.2%** |
| 40 pages appended to 5,000 positioned cards (`append-positioned`) | 30.90 → 27.40 | 30.80 → 26.80 | 30.50 → 26.80 | **-12.1%** |
| 20 column-count relayouts, 5,000 positioned cards (`relayout-positioned`) | 12.60 → 11.30 | 12.60 → 11.20 | 12.50 → 11.30 | **-10.3%** |
| 30 prepends of 20 measured rows (`prepend-measured`) | 13.00 → 12.20 | 13.00 → 12.00 | 12.70 → 12.00 | **-6.2%** |
| 40 branch switches, 2,000 measured rows (`branch-switch-measured`) | 44.10 → 42.20 | 44.20 → 42.20 | 43.60 → 42.20 | **-4.3%** |
| 600 scroll steps, positioned cards (`scroll-positioned`) | 7.00 → 6.90 | 7.00 → 6.80 | 7.00 → 6.90 | -1.4% |
| 600 streamed updates, chat options (`stream-chat-options`) | 32.30 → 32.50 | 34.60 → 33.00 | 32.60 → 32.30 | -0.9% |
| 10 boots of 2,000 measured rows (`boot-measured`) | 22.20 → 22.00 | 22.40 → 21.80 | 22.20 → 22.50 | -0.9% |
| 100 appends to 2,000 measured rows (`append-measured`) | 14.30 → 14.20 | 14.20 → 13.90 | 14.40 → 14.30 | -0.7% |
| 600 scroll steps, declared rows (`scroll-declared`) | 17.60 → 17.60 | 17.70 → 17.50 | 17.40 → 17.30 | -0.6% |
| 600 streamed updates, native anchoring (`stream-native`) | 33.70 → 33.40 | 33.60 → 34.10 | 33.50 → 33.50 | 0.0% |
| 50 unchanged `setItems`, 5,000 measured rows (`setitems-same`) | 8.60 → 8.70 | 8.70 → 8.60 | 8.60 → 8.60 | 0.0% |
| Two-tier width resize, 1,200 measured rows (`width-resize`) | 400.10 → 400.10 | 400.00 → 400.00 | 400.00 → 400.00 | 0.0% |
| 600 streamed updates, runtime anchoring (`stream-runtime`) | 38.10 → 38.10 | 40.00 → 40.40 | 38.30 → 38.50 | +0.5% |
| 600 scroll steps, native flow (`scroll-native`) | 22.60 → 22.90 | 22.80 → 22.90 | 22.30 → 22.60 | +1.3% |
| 20 full relayouts, 10,000 declared rows (`relayout-declared`) | 6.00 → 6.20 | 6.00 → 6.10 | 6.10 → 6.10 | +1.7% |
| 50 mid-list height changes, 10,000 declared rows (`midlist-declared`) | 11.20 → 11.40 | 11.30 → 11.30 | 11.20 → 11.40 | +1.8% |
| 50 pages of 40 appended to 10,000 declared rows (`append-declared`) | 14.40 → 14.70 | 14.30 → 14.60 | 14.30 → 14.70 | +2.1% |
| 600 scroll steps, runtime anchoring (`scroll-runtime`) | 31.10 → 33.40 | 30.90 → 33.50 | 34.00 → 31.20 | +7.4% |

Note on Chromium controls: `scroll-runtime` touches no changed code path and
oscillates bimodally between ~31.0 ms and ~33.5 ms in V8/Blink across trials
(+7.4%, +8.4%, and -8.2% in Trial 3); Firefox `scroll-runtime` is flat (-0.5%,
-0.3%, +0.6%). Similarly, Chromium's sub-millisecond `relayout-declared`
(6.0 → 6.1 ms) and `append-declared` (14.3 → 14.6 ms) differ by 0.1–0.3 ms
across 20–50 calls (<8 µs/call), whereas V8 already inlined spread iterators
that SpiderMonkey ran through self-hosted `ArrayIterator.next`.

## Clean code scan

- **Reachability:** `pnpm dlx knip@6.39.0` reports zero issues.
- **Clones:** `pnpm dlx jscpd@5.4.0 src integrations demos examples --min-lines 8 --min-tokens 65`
  reports zero TypeScript clones (`0.00%` across 71 TypeScript files).

## Reusable tooling

`scripts/firefox-profile/runtime-ab.mjs` now loads both `src/virtual-list.ts`
and `src/companions/index.ts` (falling back gracefully when an older baseline
predates companions), and `scripts/firefox-profile/fixtures/runtime-ab.js`
expands from 16 to 27 deterministic workloads covering positioned layouts,
declared updates and prepends, measured branch switches, `createPagedWindow`,
and `createStickyHeaders`:

```sh
node scripts/firefox-profile/runtime-ab.mjs --baseline=f18b0c6 --browser=firefox --trials=3
node scripts/firefox-profile/runtime-ab.mjs --baseline=f18b0c6 --browser=chromium --trials=3
```

## Verification and limits

- `pnpm run check` (Biome + `tsc --noEmit`): passed.
- `pnpm test`: 56 files, 5,695 unit tests passed, including new tests for
  `PositionedGeometry.fromColumns` (dense + sparse lanes), `KeyIndex.fromOwned`
  and owned extensions, `DeclaredItems.columns` and single-probe `get`,
  `Geometry.setKeys` sequential-run hints, and `createStickyHeaders` inline
  hiding and unchanged refreshes.
- `pnpm run test:firefox-profile`: 201 portable profiler and overlay checks
  passed.
- `pnpm run test:consumer`: isolated `streaming-basic` and `streaming-paged`
  production builds passed.
- Targeted three-browser regressions (`runtime`, `gallery`, `newspaper`,
  `feed`, `history`, `shared`): 55 of 57 scripts passed across Firefox,
  Chromium, and WebKit; the remaining two (`runtime/chat-profiler` from
  `6ad9b80` and `runtime/staged-row` from `06264db`) are pre-existing at
  baseline `f18b0c6`.

Local-only reproduction metadata, compact profiler summaries, source hashes,
and the candidate patch are stored under ignored
`browser-artifacts/audit-2026-11-10/`, with all raw Gecko/CDP captures and
temporary browser profiles removed.
