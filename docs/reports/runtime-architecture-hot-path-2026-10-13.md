# Runtime architecture and hot-path follow-up, October 13, 2026

This follow-up audits the runtime and geometry kernel at `v0.4.24` (`6ad9b80`)
across native-flow and positioned virtualization, isolates five hot-path and
architectural bottlenecks, and measures the resulting gains in Firefox.
Separating structural commits from height-only commits, indexing kernel and
declared-snapshot queries, and fast-pathing scroll-window transitions reduce
5,000-item measured `setItems` time by 46–48%, 10,000-item mid-list declared
`setItems` time by 61–62%, `PositionedGeometry` construction and queries by
54–56%, `Geometry` capture/resolve transactions by 33–50%, native-flow scroll
steps by 10–14%, and declared `updateItem` commits by 12–14% in Firefox.

## Conditions

- **Base revision:** `6ad9b80` (`v0.4.24`)
- **Native macOS scroll profile:** Installed Firefox 157.0 on external monitor
  `LU28R55` (`1920×1080` logical pixels, window `1900×964` at `@2x`, 60 Hz),
  fresh temporary profile, closed DevTools, native CoreGraphics wheel gestures
  (`--down=3 --up=2 --ticks=45 --temporary-raw` on `/demos/gallery/`).
- **Interleaved A/B hot-path comparison:** Firefox 155.0 (Playwright with
  `privacy.reduceTimerPrecision=false` and `MOZ_APP_DATA` isolation for macOS 27
  Mozilla bug 2060476), importing baseline `6ad9b80` (`baseline-src/`) and the
  working tree (`src/`) side by side in the same page and alternating execution
  order across 12 measured rounds (after 2 warm-up rounds) in 3 independent
  trials (`ab-1`, `ab-2`, `ab-3`).
- **Limitations:** Animation-frame and in-page synchronous timings do not
  measure physical display presentation. Scripted native wheel bursts have no
  trackpad momentum tail, and shutdown profile captures can omit GPU-process
  threads.

## Isolated findings and refactors

| Area | Finding | Refactor |
| --- | --- | --- |
| Window reconciliation (`src/virtual-list.ts`) | `commitBody` incremented `epoch` on every height-only commit (`updateItem`, `liveCommit`, `ResizeObserver`), and `reconcileWindow` checked `lastReconcile.epoch === epoch` for structural validity. Every height-only commit treated the mounted window as structurally invalidated, re-scanning `mountedRows`, re-materializing the range, and running `layoutFlow()` a second time even when `[start, end)` did not change. | Track `structureEpoch` (incremented only when `keysChanged \|\| (p?.staged.size ?? 0) > 0`). Keep the top-level `lastReconcile.epoch === epoch` fast exit, and gate window reuse on `lastReconcile.structure === structureEpoch`. |
| Native-flow & scroll window (`src/virtual-list.ts`) | `mountWindow` scanned all `mountedRows` (35 Map lookups + tuple allocation + sort) even when `kept` (`[kept.start, kept.end)`) was known; `mountedSpan()` scanned `mountedRows` on every `layoutFlow()`; `flowInsert()` scanned up to 64 successor keys when appending at the bottom of the mounted window. | Retire the two boundary slices `[kept.start, min(kept.end, range.start))` and `[max(kept.start, range.end), kept.end)` directly when `kept` is valid; return `[lastRange.start, lastRange.end - 1]` in O(1) from `mountedSpan()` when `lastReconcile.structure === structureEpoch`; insert directly after a mounted predecessor in `flowInsert()` when `!row.slot.isConnected`. |
| Indexed kernel accessors (`src/geometry.ts`, `src/virtual-list.ts`) | `Geometry.capture`, `anchorTarget`, `recomputeReserve`, `layoutFlow`, and `positionOf` converted known indices back to keys only to re-probe `indexByKey` (`Map<string, number>`) two to three times per call. | Add `heightAt(index)`, `offsetAt(index)`, and `anchorIndexAt(viewport)` on `Geometry`; store `oldOrder: KeyIndex` on `Capture` so `resolveMode` uses `oldOrder === this.order \|\| oldOrder.prefixes(this.keys)` instead of a duplicate prefix scan. |
| Declared & measured snapshots (`src/declared-items.ts`, `src/virtual-list.ts`) | `confined(p)` scanned all 10,000 declared items with two Map lookups per item; `indexItems` allocated an unused `byKey` Map on every measured `setItems` and only used the `priorKeys` prefix fast-path when `heights` was non-null; `stageSnapshot` copied and sorted all `rows.keys()` on every declared `setItems`. | Add `DeclaredItems.shiftsBefore(anchorIndex, geometry)` (indexed prefix check with zero Map probes and early exit) and `DeclaredItems.forEach(visit, unchanged)`; remove `byKey` from `indexItems`, enable prefix-uniqueness skipping for all snapshots, reuse `desiredIndex.keys` when unchanged, and stage only mutated/broken or previously staged declared rows. |
| Positioned geometry & commit hygiene (`src/positioned-geometry.ts`, `src/virtual-list.ts`) | `PositionedGeometry` probed `lanes` twice per item, unconditionally ran `indices.sort` on already-ordered lanes, and boxed `lane.bottoms` in `number[]`. `commitBody` evaluated `anchorOnly` and `viewport.scrollTop` (`engineMoved`) even when short-circuitable, and allocated `gone` and `toMeasure` Sets on every commit. | Single Map lookup per lane, O(N) pre-check before `indices.sort`, and `Float64Array` for `lane.bottoms`. Short-circuit `anchorOnly` and `engineMoved`, maintain `dirtyRows` directly in `commitBody`, and lazily allocate `adopted` in `prepare`. |

## Interleaved Firefox A/B comparison (3 trials)

Each trial runs 12 measured rounds (after 2 warm-up rounds) alternating
baseline and candidate in the same Firefox 155.0 page. Values are medians in
milliseconds across the 12 rounds per trial.

| Workload | Trial 1 (Base → Cand) | Trial 2 (Base → Cand) | Trial 3 (Base → Cand) | Median Δ |
| --- | ---: | ---: | ---: | ---: |
| `kernel:geometry-capture-resolve(5k,500ops)` | 0.20 → 0.12 ms | 0.24 → 0.12 ms | 0.18 → 0.12 ms | **-40.0%** |
| `kernel:positioned-geometry(5k,40ops)` | 7.74 → 3.44 ms | 7.34 → 3.40 ms | 7.36 → 3.40 ms | **-53.8%** |
| `runtime:native:setItems-same(5k,25ops)` | 23.40 → 12.54 ms | 23.34 → 12.56 ms | 23.54 → 12.36 ms | **-46.4%** |
| `runtime:declared:setItems-midlist(10k,50ops)` | 65.26 → 24.86 ms | 65.28 → 25.30 ms | 65.02 → 24.82 ms | **-61.8%** |
| `runtime:declared:updateItem(300ops)` | 6.84 → 5.92 ms | 6.84 → 6.00 ms | 6.88 → 5.98 ms | **-13.1%** |
| `runtime:native:scroll-steps(200ops)` | 10.74 → 9.54 ms | 10.36 → 9.32 ms | 10.68 → 9.20 ms | **-11.2%** |
| `runtime:native:updateItem-tail(300ops)` | 13.70 → 13.12 ms | 13.52 → 12.72 ms | 13.74 → 12.98 ms | **-5.5%** |
| `runtime:positioned:scroll-steps(200ops)` | 8.58 → 8.80 ms | 8.32 → 8.14 ms | 8.50 → 8.34 ms | **-1.9%** |
| `runtime:positioned:updateItem-tail(300ops)` | 13.40 → 13.18 ms | 13.40 → 13.04 ms | 13.68 → 13.46 ms | **-1.6%** |

## Native Firefox scroll profile on `LU28R55`

Both runs used installed Firefox 157.0 on `LU28R55` (`1900×964` viewport at
`@2x`, 60 Hz) over 3 downward and 2 upward native wheel bursts (`--ticks=45`)
on `/demos/gallery/`, reaching `top=3240` (`height=9627`, 240 cards across 5
columns) and returning to `top=1080` with all 5 `scrollend` events observed.

| Metric | Baseline (`run-3JHdb0`) | Candidate (`run-klDvTP`) |
| --- | ---: | ---: |
| Moving frame interval p50 / p95 / max | 16.76 / 17.12 / 17.54 ms | 16.78 / 17.20 / 17.54 ms |
| Long frame intervals (>25 ms) / scroll writes | 0 / 0 | 0 / 0 |
| `scrollHandlersMs` total / p50 / p95 | 38.67 / 0.039 / 1.012 ms | 34.92 / 0.040 / 0.909 ms |
| `RefreshDriverTick` p50 / p95 / max | 0.492 / 1.390 / 5.560 ms | 0.553 / 1.332 / 5.386 ms |
| `DisplayList` p50 / p95 / max | 0.221 / 0.376 / 1.525 ms | 0.231 / 0.323 / 0.515 ms |
| `Reflow (sync)` p50 / p95 / max | 0.093 / 0.355 / 0.924 ms | 0.103 / 0.322 / 0.563 ms |
| `GCMinor` / `GCSlice` total | 2.118 ms (3) / 4.942 ms (4) | 0.799 ms (1) / 0 ms (0) |

## Verification

- `pnpm run check` (`biome check . && tsc --noEmit`): passed.
- `pnpm test`: 55 test files, 5,674 unit and DOM tests passed (including new unit
  coverage in `tests/unit/geometry.test.ts` and `tests/unit/declared-items.test.ts`).
- `pnpm run test:consumer`: passed.
- `pnpm run test:firefox-profile`: 197 portable profiler and overlay checks passed.
- `pnpm run test:browser`: full cross-browser matrix (Chromium, Firefox, WebKit) passed.
- `pnpm run test:regression`: `data-structures`, `runtime-boundaries`,
  `declared-pooling`, `native-anchoring`, `streaming-height`,
  `row-construction`, `hidden-row`, `staged-row`, `live-shrink`, and
  `window-navigation` passed across Firefox, Chromium, and WebKit.

Compact summaries, patches, and reproduction metadata are stored under
`browser-artifacts/runtime-review-2026-10-13/`.
