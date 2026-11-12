# Runtime scrolling and resource-usage 2x optimization, November 11, 2026

This optimization profiles and rearchitects the core virtualization runtime,
geometry kernels, companions, integrations, and gallery/preview surfaces on top
of `8bbef7c` (`v0.8.0`) to deliver at least a **2x improvement** across
scrolling performance and resource usage without changing any public API or
behavioral invariant (`I0–I6`).

In the installed Firefox 159.0.1 on `LU28R55` (`1920x1080` at `2x` scaling,
`60 Hz`), native macOS scrolling cuts synchronous DOM geometry reads during
steady chat scrolling by **56.5% (`2,211 → 962`, `2.30x` fewer reads)**,
eliminating all interior `scrollHeight`, `clientHeight`, and
`getBoundingClientRect` reads. Wheel-event handler `p50` latency drops by
**51.9–52.5% (`2.08–2.10x` faster)** in chat and declared lists, `handleWheel`
Gecko samples drop by **50.0–55.6% (`2.00–2.25x` fewer)** across declared rows
and gallery paging, gallery `scrollHandlersMs.p50` drops by **48.7% (`0.078 →
0.040 ms`, `1.95x` faster)**, synchronous reflow `p50` drops by **64.7%
(`0.102 → 0.036 ms`, `2.83x` faster)**, `RefreshDriverTick` `p50` drops by
**68.3% (`0.401 → 0.127 ms`, `3.16x` faster)**, and content-process `Awake` CPU
during gallery scrolling drops by **26.3% (`732.04 → 539.22 ms`)** with zero
long frame intervals (`1 → 0`).

In Firefox 159.0.1 `about:memory` captures, replacing `Map<string, number>` key
tables with an open-addressed `Int32Array` `KeyTable`, sharing height arrays
with copy-on-write semantics, compacting positioned lane storage, and removing
transient `Set`/`Map`/closure allocations reduces `100,000`-item natural list
window memory by **51.9% net (`92.096 → 44.254 MiB`, `2.08x` reduction)**,
sparse `Geometry` natural window memory by **53.2% net (`55.523 → 25.967 MiB`,
`2.14x` reduction)**, loaded `Geometry` net storage by **48.1% (`10.417 →
5.403 MiB`, `1.93x` reduction, `Map` class `5.25 MiB → 0 B`)**, exercised
`PositionedGeometry` net storage by **96.6% (`1.040 → 0.035 MiB`, `29.7x`
reduction)**, overlapping `PositionedGeometry` exercised net storage by **68.2%
(`1.489 → 0.473 MiB`, `3.15x` reduction)**, and `mixed-natural` (`measured:2000`)
`Map` heap by **91.9% (`1,527,904 → 123,360 B`, `12.4x` reduction)** uncollected
and **75.0% (`306,656 → 76,560 B`, `4.0x` reduction)** after collection while
lowering lifetime content-process physical peaks in both suites (`304.803 →
301.109 MiB` and `112.408 → 109.986 MiB`). At `100,000` items, `positioned-list`
`updateItem` improves by **8.01x (`937 → 117 ms` across 60 edits, median `15 →
2 ms`)** and overlapping `anchor-gaps` improves by **61x (`61 → 1 ms`)**.

In 3-trial interleaved headless A/B benchmarks against `8bbef7c` in Firefox
157.0, unchanged `setItems` improves by **85.8% (`7.0x`)**, positioned card
updates by **67.6–68.4% (`3.1x`)**, declared boots by **52.4% (`2.10x`)**,
declared prepends by **46.3% (`1.86x`)**, positioned boots by **44.3%
(`1.80x`)**, mid-list declared edits by **36.8% (`1.58x`)**, paging load/trims
by **25.7%**, positioned appends by **23.1%**, declared appends by **18.8%**,
and runtime-anchored streaming by **16.7%**.

## Conditions

Native scrolling, boot timing, and `about:memory` retention captures ran in the
installed Firefox **159.0.1** (build `20261102144711`) on **macOS 27.2** (build
`26B123`) using fresh temporary browser profiles and closed DevTools on external
display **`LU28R55`** (`1920x1080` logical pixels at `2x` DPR, `60 Hz`, browser
window `1900x1049` outer / `1900x964` inner). Scroll captures drove native macOS
CoreGraphics wheel gestures via `scripts/firefox-profile/native.swift` (`pnpm
run profile:firefox` and `pnpm run profile:chat`), limited to three trials per
comparison round.

Interleaved runtime A/B comparisons ran in Playwright Firefox **157.0**
(`privacy.reduceTimerPrecision=false`) and headless Chromium **156.0.8078.4**
(`1280x900` viewport), loading `8bbef7c` and the candidate runtime side by side
in a fresh page per trial across 12 alternating measured rounds after 2 warm-up
rounds (3 trials per browser).

Measurement boundaries:

- Native CoreGraphics wheel runs exercise Firefox's macOS APZ wheel input path,
  compositor, paint, and scroll-end handling on `LU28R55`, but do not replace
  manual physical trackpad gesture-release momentum. Animation-frame cadence
  alone is not treated as proof of smooth physical presentation.
- Headless A/B workloads isolate JavaScript execution and synchronous layout
  without paint or display presentation.

## Profile findings and retained changes

| Bottleneck at `8bbef7c` | Measured cost | Retained change |
| --- | --- | --- |
| `ScrollSettle` read `scrollTop` twice plus `scrollHeight` and `clientHeight` on every `scroll` and `wheel` event, and `currentRatio()` read `getBoundingClientRect()` even when no DPR-dependent geometry ran (`src/scroll-settle.ts`, `src/virtual-list.ts`). | 2,211 DOM geometry reads across a single `steady` chat scroll (`348` `scrollTop` + `522` `scrollHeight`/`clientHeight` in `handleScroll`, `356` in `handleWheel`, `180` `getBoundingClientRect`) | Added `lowerBoundMaxScrollTop` host fast path (`lastCanvasHeightPx` minus cached `clientHeight`), single-read `scrollTop` interior handling in `handleScroll` and `handleWheel`, coalesced `settleTimer` (`armSettleTimer` cancels `settleFrame`), and lazy `currentRatio()` evaluation in `pass()`. |
| `KeyIndex` and `createPagedWindow` stored `Map<string, number>` tables per key order and per retained page, plus transient `protectedKeys` `Set` and `owners` `Map` on every `apply()` (`src/key-index.ts`, `src/paging.ts`). | `47.19 MiB` `Map` heap in `list:100000:natural`, `5.25 MiB` loaded `Map` at `100,000` keys (`~52 B/key`), `1.53 MiB` `Map` in `mixed-natural` | Replaced `Map` indices with open-addressed `KeyTable` backed by a single `Int32Array` (`0` = empty, `index + 1` = occupied, FNV-1a + Murmur3 avalanche, Knuth Algorithm R deletion, `78.125%` max load factor = `0.50 MiB` at `100,000` keys), prefix-shared `truncate`, `sameChain` reuse, and zero-`Set`/`Map` non-trimming `createPagedWindow.apply()`. |
| `DeclaredItems` and `Geometry` copied `items` and `Float64Array` height buffers on every snapshot and eagerly rebuilt the Fenwick tree even when positioned layout owned coordinates (`src/declared-items.ts`, `src/geometry.ts`, `src/fenwick.ts`). | ~17 ms of `boot-declared`, ~20 ms of `prepend-declared`, duplicate `800 KB` `Float64Array` copies at `100,000` rows | Adopted owned snapshots without `.slice()`, shared `heights` copy-on-write (`heightsShared` + early `this.heights[index] === height` guard in `learn()`), deferred Fenwick rebuild via `treeDirty` under positioned layout, and added in-place `Fenwick.rebuild()` + $O(\log N)$ `truncate()`. |
| `PositionedGeometry` boxed lane indices in JS `Array`s, retained redundant `bottoms` arrays on monotone lanes, scanned overlapping lanes linearly in `window()` / `anchorAt()`, and rebuilt all lanes on single-card `updateItem` (`src/positioned-geometry.ts`, `src/virtual-list.ts`). | `1.04 MiB` exercised `Array` overhead at `100,000` cards, `61 ms` `anchor-gaps` on overlapping lanes, `937 ms` across 60 `updateItem` calls at `100,000` cards | Packed `lane.indices` into exact-sized `Int32Array` in two passes, omitted `bottoms` when `monotone` (`tops[i] + heights[idx]`), added a flat max-bottom segment tree + `scanSegTreeAbove` ($O((k+1)\log m)$), reused `lanesScratch`/`topsScratch`, and added $O(\text{lanes})$ `applyUpdateInPlace` + `finalizePositionedColumns` on `updateItem`. |
| `pass()`, `reconcileWindow()`, `mountRow()`, `createStickyHeaders`, `createMeasuredText`, `photo-preview`, and `gallery` allocated per-pass closures/sets/controllers and lacked layout containment on off-flow shells (`src/virtual-list.ts`, `src/companions/sticky-headers.ts`, `integrations/measured-text.ts`, `demos/`). | `25,336 B` `Call` closures in `mixed-natural`, `0.401 ms` `RefreshDriverTick` `p50` and `0.102 ms` sync reflow `p50` in gallery scroll | Pooled `scopePool` and `slotPool` across `native` and `!native` modes, applied direct property deltas on `native` `hidden <-> mounted` transitions, skipped `rowOf` `WeakMap` when `declared \|\| spec`, cached sticky-header CSS offsets, shared one `ResizeObserver` + probe in `measured-text`, replaced per-card `AbortController`/closures with flat `PhotoBinding`s, and added scoped CSS containment. |

## Candidates evaluated and revised or rejected

- **`contain: strict` on `native` flow slots (evaluated and revised).** Applying
  `contain: strict` to all `.vl-i` slots regressed `branch-switch-measured` by
  ~16% in Firefox because toggling `contain: none` ↔ `contain: strict` across
  `hidden <-> mounted` transitions forced frame reconstruction on measured flow
  rows. Scoping `contain: strict` exclusively to `!native` positioned slots
  preserved the scroll/paint isolation gain while turning
  `branch-switch-measured` into a **-5.0%** improvement.
- **`contain: layout style` on WebKit `!native` canvas (evaluated and revised).**
  CSS Containment Level 2 §3.1 flattens `transform-style` to `flat` under
  `contain: layout`, overriding `canvas.style.transformStyle = "preserve-3d"` on
  WebKit and breaking `runtime/native-animation` (`webkit:
  recent-native-takeover`). Scoping `canvas.style.contain = "layout style"` to
  `!webkitCompositing` keeps Firefox and Chromium layout containment while
  preserving WebKit's compositing surface.
- **Single-item `place(item)` evaluation in positioned `updateItem` (evaluated
  and revised).** Calling `place(item)` only for the edited item skipped
  cross-item column cursor updates relied upon by stateful masonry hosts
  (`runtime/runtime-boundaries`). Revising `updateItem` to evaluate `place(it)`
  once across the snapshot into reusable typed-array scratch columns—then taking
  zero-allocation `positionedPatch` when `canUpdateInPlace && matchesExcept`
  holds, or single-pass `finalizePositionedColumns` without `indexItems` /
  `DeclaredItems` rebuild when downstream cards shift—preserves the contract and
  still delivers **-68.4% (`3.1x`)** on `update-positioned`, **-67.6% (`3.1x`)**
  on `update-positioned-move`, and **8.01x (`937 → 117 ms`)** at `100,000`
  positioned items.
- **`50%` vs `78.125%` `KeyTable` max load factor (evaluated and tightened).** A
  `50%` load cap allocated `262,144` `Int32Array` slots (`1.00 MiB`) at
  `100,000` keys; raising the cap to `25/32` (`78.125%`) keeps `100,000` keys in
  `131,072` slots (`0.50 MiB`, `10x` smaller than `Map`) with no measurable
  probe slowdown.

## Native Firefox 159.0.1 scrolling and boot (`LU28R55`)

### Steady chat scroll diagnostic DOM-read isolation

Single diagnostic captures (`pnpm run profile:chat -- --browser=firefox
--mode=diagnostic --scenario=steady --steady-speed=fast --display=LU28R55`,
`firefox-diagnostic-AfwbSN` → `firefox-diagnostic-flUYkS`):

| Metric | Baseline (`8bbef7c`) | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Total DOM geometry accesses | 2,211 | 962 | **-56.5% (`2.30x` fewer)** |
| `handleScroll\|read:clientHeight` | 348 | 0 | **-100.0%** |
| `handleScroll\|read:scrollHeight` | 174 | 0 | **-100.0%** |
| `handleWheel\|read:scrollHeight` | 178 | 0 | **-100.0%** |
| `handleWheel\|read:clientHeight` | 178 | 0 | **-100.0%** |
| `viewportState\|call:getBoundingClientRect` | 180 | 0 | **-100.0%** |
| `handleScrollEnd\|read:scrollHeight` + `clientHeight` | 12 | 0 | **-100.0%** |
| `handleScroll\|read:scrollTop` | 348 | 179 | **-48.6%** |
| `handleWheel` JS duration | 12 ms | 4 ms | **-66.7% (`3.00x` faster)** |
| `onScrolled` inclusive JS duration | 45 ms | 28 ms | **-37.8%** |
| `handleScroll` inclusive JS duration | 49 ms | 32 ms | **-34.7%** |
| `sticky-headers:updatePosition` JS duration | 5 ms | 0 ms | **-100.0%** |

### Three-trial native macOS wheel scrolling (`LU28R55`, `1920x1080 @2x`, `60 Hz`)

Medians across 3 independent fresh-profile trials per workload in Firefox
159.0.1 (trial values in brackets where helpful):

| Workload & metric | Baseline (`8bbef7c`) | Candidate | Delta |
| --- | ---: | ---: | ---: |
| **Chat `steady` (`OjG5mn, Vs5Hnx, fBj7vm` → `PgzFj4, XX6bZS, bd8Cn9`)** | | | |
| `DOMEvent:wheel` `p50` (ms) | 0.061 | 0.029 | **-52.5% (`2.10x` faster)** |
| `DOMEvent:wheel` total (ms) | 15.68 | 8.42 | **-46.3% (`1.86x` faster)** |
| `DOMEvent:scroll` `p50` (ms) | 0.062 | 0.042 | **-32.3%** |
| `DOMEvent:scroll` total (ms) | 33.96 | 27.64 | **-18.6%** |
| Runtime nearest-JS Gecko samples | 32 `[27, 32, 43]` | 19 `[17, 23, 19]` | **-40.6%** |
| Content-process `Awake` CPU (ms) | 258.31 | 217.18 | **-15.9%** |
| **Declared rows (`9peKFt, ZRS1i6, qXCp17` → `9Dtfcn, cu4G9T, oAyt2k`)** | | | |
| `DOMEvent:wheel` `p50` (ms) | 0.052 | 0.025 | **-51.9% (`2.08x` faster)** |
| `DOMEvent:wheel` total (ms) | 36.49 | 18.38 | **-49.6% (`1.99x` faster)** |
| `handleWheel` inclusive Gecko samples | 27 `[36, 27, 20]` | 12 `[16, 9, 12]` | **-55.6% (`2.25x` fewer)** |
| **Gallery `rows` + paging + decode (`JE566z, dXRIgP, fWFJiu` → `DXlpo8, Jak3dO, UeKzOx`)** | | | |
| `handleWheel` inclusive Gecko samples | 50 `[50, 62, 47]` | 25 `[20, 25, 26]` | **-50.0% (`2.00x` fewer)** |
| `scrollHandlersMs` `p50` (ms) | 0.078 | 0.040 | **-48.7% (`1.95x` faster)** |
| `scrollHandlersMs` total (ms) | 76.85 | 55.31 | **-28.0%** |
| `Reflow (sync)` `p50` (ms) | 0.102 | 0.036 | **-64.7% (`2.83x` faster)** |
| `Reflow (sync)` total (ms) | 25.51 | 18.28 | **-28.3%** |
| `RefreshDriverTick` `p50` (ms) | 0.401 | 0.127 | **-68.3% (`3.16x` faster)** |
| `RefreshDriverTick` total (ms) | 448.20 | 334.74 | **-25.3%** |
| `DOMEvent:wheel` total (ms) | 65.18 | 39.04 | **-40.1%** |
| `DoFlushPendingNotifications` total (ms) | 105.55 | 77.30 | **-26.8%** |
| Runtime nearest-JS Gecko samples | 81 | 57 | **-29.6%** |
| Content-process `Awake` CPU (ms) | 732.04 `[659.6–764.6]` | 539.22 `[524.8–623.5]` | **-26.3% (non-overlapping)** |
| Long frame intervals (`> 25 ms`) | 1 (`max 200.2 ms`) | 0 (`max 17.68 ms`) | **Eliminated** |

### Streaming demo boot (`pnpm run profile:boot`)

In installed Firefox 159.0.1 (`/demos/streaming/`, median of 6 loads each):

- Cold `chat:visible`: **172 ms → 144 ms (-16.3%)**
- Warm `chat:visible`: **104 ms → 100 ms (-3.8%)**

## Resource usage and 100,000-item kernels in Firefox 159.0.1

### Data-structure storage (`structures-natural`, `run-kImWkD` → `run-Obh5VF`)

Values report explicit window allocations in MiB and net window allocations
above the initial `empty` checkpoint (`0.721 MiB` baseline, `0.765 MiB`
candidate). Every `Map` allocation (`5.25 MiB` loaded and up to `47.19 MiB`
natural) drops to **0 bytes** across all `Geometry`, `list`, and
`positioned-list` checkpoints. Content-process cumulative lifetime physical peak
across the entire suite decreases from **304.803 MiB** to **301.109 MiB**.

| Checkpoint | Baseline window (net) MiB | Candidate window (net) MiB | Net delta | `Map` class bytes |
| --- | ---: | ---: | ---: | ---: |
| `geometry:10000:loaded` | 1.590 (0.869) | 1.340 (0.574) | **-34.0%** | 297,504 → **0** |
| `geometry:100000:loaded` | 11.138 (10.417) | 6.169 (5.403) | **-48.1% (`1.93x`)** | 5,245,472 → **0** |
| `geometry:100000:exercised` | 10.073 (9.352) | 5.873 (5.107) | **-45.4%** | 5,245,472 → **0** |
| `geometry:100000:buffers-materialized` | 11.608 (10.887) | 6.638 (5.873) | **-46.1%** | 5,245,472 → **0** |
| `geometry-sparse:100000:loaded` | 11.141 (10.420) | 6.172 (5.406) | **-48.1% (`1.93x`)** | 5,245,472 → **0** |
| `geometry-sparse:100000:natural` | 56.244 (55.523) | 26.733 (25.967) | **-53.2% (`2.14x`)** | 41,946,472 → **0** |
| `positioned:100000:loaded` | 3.499 (2.778) | 2.440 (1.674) | **-39.7%** | 0 → 0 (`Array` 1.05M → **0**) |
| `positioned:100000:exercised` | 1.761 (1.040) | 0.801 (0.035) | **-96.6% (`29.7x`)** | 0 → 0 (`Array` 1.05M → **0**) |
| `positioned:100000:buffers-materialized` | 3.297 (2.576) | 2.332 (1.566) | **-39.2%** | 0 → 0 (`Array` 1.05M → **0**) |
| `positioned-overlap:100000:exercised` | 2.210 (1.489) | 1.239 (0.473) | **-68.2% (`3.15x`)** | 0 → 0 (`Array` 1.05M → **0**) |
| `positioned-overlap:100000:buffers-materialized` | 3.745 (3.024) | 2.770 (2.005) | **-33.7%** | 0 → 0 (`Array` 1.05M → **0**) |
| `list:100000:loaded` | 16.960 (16.239) | 11.732 (10.966) | **-32.5%** | 5,246,984 → **0** |
| `list:100000:natural` | 92.817 (92.096) | 45.020 (44.254) | **-51.9% (`2.08x`)** | 47,191,704 → **0** |
| `list:100000:exercised` | 15.641 (14.921) | 9.920 (9.155) | **-38.6%** | 5,246,984 → **0** |
| `positioned-list:100000:loaded` | 20.162 (19.441) | 13.066 (12.300) | **-36.7%** | 5,254,024 → **0** |
| `positioned-list:100000:exercised` | 17.038 (16.318) | 10.329 (9.564) | **-41.4%** | 5,254,024 → **0** |

Note on uncollected `:natural` point samples: as documented in the
[October 1 key-index study](runtime-key-index-2026-10-01.md), unforced
`:natural` checkpoints depend on SpiderMonkey nursery/major GC timing during
back-to-back 100,000-item batches (`positioned-list:100000:natural` sampled
`27.320` vs `68.078 MiB` before collection, then `17.038 → 10.329 MiB`
collected). Collected `:loaded`, `:exercised`, and `:buffers-materialized`
checkpoints establish deterministic retained-storage reductions, and `:released`
checkpoints return to baseline (`0.028–0.473 MiB` net, `activeItems: 0`).

### 100,000-item operation timings (`structures-natural`, `run-kImWkD` → `run-Obh5VF`)

| Case & operation (100,000 items) | Baseline ms | Candidate ms | Delta |
| --- | ---: | ---: | ---: |
| `positioned-overlap` `anchor-gaps` (1,000 queries, median of 3) | 61 `[58, 61, 63]` | 1 `[1, 1, 1]` | **-98.4% (`61.0x` faster)** |
| `positioned-list` `updateItem` (60 calls total / median) | 937 / 15 | 117 / 2 | **-87.5% (`8.01x` faster)** |
| `list` `updateItem` (60 calls total / median) | 41 / 1 | 14 / 0 | **-65.9% (`2.93x` faster)** |
| `geometry-sparse` `reorder` (10 reorders, median of 3) | 162 `[201, 162, 135]` | 74 `[74, 74, 72]` | **-54.3% (`2.19x` faster)** |
| `geometry-sparse` `read-and-search` (50,000 queries, median of 5) | 49 | 24 | **-51.0% (`2.04x` faster)** |
| `positioned-list` `append-remove` (4 pairs, median of 3) | 204 `[204, 208, 198]` | 114 `[109, 114, 120]` | **-44.1%** |
| `list` `append-remove` (4 pairs, median of 3) | 158 `[158, 156, 160]` | 92 `[98, 88, 92]` | **-41.8%** |
| `positioned-list` `prepend-remove` (4 pairs, median of 3) | 250 `[250, 243, 254]` | 152 `[152, 157, 146]` | **-39.2%** |
| `positioned-list` `replace-order` (4 replacements, median of 3) | 121 `[120, 121, 145]` | 76 `[73, 77, 76]` | **-37.2%** |
| `list` `prepend-remove` (4 pairs, median of 3) | 205 `[205, 205, 210]` | 135 `[132, 135, 139]` | **-34.1%** |
| `geometry` `reorder` (10 reorders, median of 3) | 109 `[131, 109, 105]` | 72 `[69, 72, 76]` | **-33.9%** |
| `geometry` `fenwick-rebuild` (20 rebuilds, median of 3) | 12 `[11, 13, 12]` | 8 `[9, 7, 8]` | **-33.3%** |
| `list` `replace-order` (4 replacements, median of 3) | 96 `[91, 96, 100]` | 74 `[98, 67, 74]` | **-22.9%** |

### Paged retention and memory gate (`mixed-natural` & `profile-memory.mjs`)

In `mixed-natural` (`8` cycles, `run-oBGabw` → `run-nrjRxH`), content-process
lifetime physical peak decreases from **112.408 MiB** to **109.986 MiB**:

- `measured:480:loaded` `Map` heap: **35,960 B → 0 B (-100%)**; `natural` `Map`
  heap: **303,168 B → 35,344 B (-88.3%, `8.58x` reduction)**; `exercised` `Map`
  heap: **97,760 B → 23,312 B (-76.2%, `4.19x` reduction)**.
- `measured:2000:natural` window memory: **37.388 → 34.864 MiB (-6.8%)**; `Map`
  heap: **1,527,904 B → 123,360 B (-91.9%, `12.39x` reduction)**; `Call` closure
  objects: **25,336 B → 0 B (-100%)**; `exercised` `Map` heap: **306,656 B →
  76,560 B (-75.0%, `4.01x` reduction)**.
- `profile-memory.mjs` (`--browser=firefox --workload=text --cycles=6
  --display=LU28R55`): **passed** (`failures: []`, process peak **447.5 →
  441.8 MB**, post-warmup growth **-22.0 MB**).

## Interleaved runtime A/B comparison (`8bbef7c` vs candidate)

Each cell is the median of 12 alternating rounds in milliseconds (`baseline →
candidate`). Bold deltas mark paths directly targeted by the retained changes.

Firefox 157.0:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 50 unchanged `setItems`, 5,000 measured rows (`setitems-same`) | 21.72 → 3.14 | 21.68 → 3.08 | 27.84 → 3.72 | **-85.8% (`7.0x`)** |
| 50 in-place card edits, 5,000 positioned cards (`update-positioned`) | 16.96 → 5.28 | 15.88 → 5.16 | 16.12 → 5.10 | **-68.4% (`3.1x`)** |
| 50 moving card edits, 5,000 positioned cards (`update-positioned-move`) | 16.74 → 5.42 | 16.24 → 5.40 | 16.76 → 5.34 | **-67.6% (`3.1x`)** |
| 10 boots of 20,000 declared rows (`boot-declared`) | 32.86 → 15.84 | 34.08 → 15.86 | 44.04 → 20.96 | **-52.4% (`2.1x`)** |
| 30 prepends of 40 to 10,000 declared rows (`prepend-declared`) | 44.28 → 23.78 | 51.36 → 27.32 | 44.72 → 24.56 | **-46.3% (`1.9x`)** |
| 10 boots of 10,000 positioned cards (`boot-positioned`) | 19.20 → 10.70 | 23.32 → 10.66 | 19.98 → 12.70 | **-44.3% (`1.8x`)** |
| 50 mid-list height changes, 10,000 declared rows (`midlist-declared`) | 16.22 → 10.96 | 18.00 → 11.38 | 22.56 → 13.80 | **-36.8% (`1.6x`)** |
| Overlapping page loads, jumps, and trims (`paging-load-trim`) | 166.32 → 93.86 | 104.84 → 78.74 | 93.00 → 69.10 | **-25.7%** |
| 40 pages appended to 5,000 positioned cards (`append-positioned`) | 40.38 → 30.90 | 38.62 → 31.12 | 39.84 → 30.62 | **-23.1%** |
| 50 pages of 40 appended to 10,000 declared rows (`append-declared`) | 24.96 → 20.28 | 27.42 → 15.74 | 35.92 → 31.90 | **-18.8%** |
| 600 streamed updates, runtime anchoring (`stream-runtime`) | 30.24 → 25.54 | 41.14 → 33.96 | 30.98 → 25.80 | **-16.7%** |
| 20 full relayouts, 10,000 declared rows (`relayout-declared`) | 19.34 → 16.30 | 19.70 → 17.10 | 25.50 → 22.36 | **-13.2%** |
| 20 column-count relayouts, 5,000 positioned cards (`relayout-positioned`) | 23.46 → 21.00 | 20.88 → 16.60 | 21.12 → 19.04 | **-10.5%** |
| 600 scroll steps, declared rows (`scroll-declared`) | 20.36 → 18.94 | 21.12 → 19.66 | 24.60 → 22.30 | **-7.0%** |
| 600 scroll steps, runtime anchoring (`scroll-runtime`) | 29.70 → 27.80 | 28.56 → 28.12 | 32.78 → 30.22 | **-6.4%** |
| 600 scroll steps + 40 sticky refreshes (`sticky-headers`) | 31.90 → 29.88 | 33.22 → 31.70 | 32.02 → 30.36 | **-5.2%** |
| 40 branch switches, 2,000 measured rows (`branch-switch-measured`) | 59.68 → 57.10 | 61.54 → 58.44 | 57.50 → 54.62 | **-5.0%** |
| 600 scroll steps, positioned cards (`scroll-positioned`) | 11.94 → 11.76 | 12.90 → 12.40 | 13.38 → 12.70 | **-3.9%** |
| 600 streamed updates, chat options (`stream-chat-options`) | 29.48 → 28.82 | 38.02 → 33.82 | 36.28 → 35.04 | -3.4% |
| 600 scroll steps, native flow (`scroll-native`) | 32.08 → 30.68 | 35.86 → 34.80 | 32.22 → 31.38 | **-3.0%** |
| 300 single-item edits, 10,000 declared rows (`update-declared`) | 24.44 → 23.66 | 24.12 → 23.48 | 24.28 → 23.66 | -2.7% |
| 200 live edits, 4,000 paged rows (`paging-live-edit`) | 2.08 → 1.96 | 1.96 → 1.96 | 1.92 → 1.88 | -2.1% |
| 100 appends to 2,000 measured rows (`append-measured`) | 25.28 → 24.78 | 29.32 → 27.72 | 27.66 → 27.20 | -2.0% |
| 30 prepends of 20 measured rows (`prepend-measured`) | 16.78 → 16.44 | 16.30 → 16.16 | 18.42 → 18.06 | -2.0% |
| 600 streamed updates, native anchoring (`stream-native`) | 29.40 → 28.88 | 36.82 → 43.54 | 29.96 → 29.72 | -0.8% |
| Two-tier width resize, 1,200 measured rows (`width-resize`) | 396.26 → 399.88 | 395.24 → 395.92 | 399.90 → 399.98 | +0.2% |
| 10 boots of 2,000 measured rows (`boot-measured`) | 28.76 → 29.00 | 29.32 → 29.46 | 41.34 → 40.46 | +0.5% |

Chromium 156.0.8078.4:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 50 in-place card edits, 5,000 positioned cards (`update-positioned`) | 12.10 → 3.40 | 11.80 → 3.50 | 11.70 → 3.40 | **-70.9% (`3.4x`)** |
| 50 unchanged `setItems`, 5,000 measured rows (`setitems-same`) | 8.90 → 3.30 | 8.70 → 3.30 | 8.80 → 3.30 | **-62.5% (`2.7x`)** |
| 50 moving card edits, 5,000 positioned cards (`update-positioned-move`) | 12.50 → 4.90 | 12.20 → 5.00 | 12.00 → 4.90 | **-59.2% (`2.5x`)** |
| 10 boots of 20,000 declared rows (`boot-declared`) | 16.80 → 10.00 | 17.10 → 9.80 | 18.50 → 10.60 | **-42.7%** |
| 10 boots of 10,000 positioned cards (`boot-positioned`) | 11.00 → 7.00 | 11.00 → 7.10 | 10.80 → 7.00 | **-35.5%** |
| 30 prepends of 40 to 10,000 declared rows (`prepend-declared`) | 22.40 → 15.70 | 22.50 → 15.80 | 22.30 → 15.60 | **-29.9%** |
| 50 pages of 40 appended to 10,000 declared rows (`append-declared`) | 14.40 → 10.80 | 14.70 → 10.60 | 15.90 → 11.50 | **-27.7%** |
| 600 streamed updates, runtime anchoring (`stream-runtime`) | 39.30 → 30.10 | 40.90 → 32.30 | 38.70 → 29.90 | **-22.7%** |
| 40 pages appended to 5,000 positioned cards (`append-positioned`) | 27.60 → 22.10 | 27.20 → 21.80 | 26.70 → 21.30 | **-19.9%** |
| 50 mid-list height changes, 10,000 declared rows (`midlist-declared`) | 11.40 → 9.50 | 11.30 → 9.50 | 11.60 → 9.90 | **-15.9%** |
| 20 full relayouts, 10,000 declared rows (`relayout-declared`) | 6.10 → 5.30 | 6.10 → 5.30 | 6.30 → 5.30 | **-13.1%** |
| Overlapping page loads, jumps, and trims (`paging-load-trim`) | 45.50 → 39.60 | 46.00 → 40.10 | 46.10 → 40.00 | **-13.0%** |
| 20 column-count relayouts, 5,000 positioned cards (`relayout-positioned`) | 11.10 → 9.90 | 11.10 → 10.00 | 11.20 → 9.80 | **-10.8%** |
| 200 live edits, 4,000 paged rows (`paging-live-edit`) | 1.00 → 0.90 | 0.90 → 1.00 | 0.90 → 0.80 | **-10.0%** |
| 600 scroll steps, positioned cards (`scroll-positioned`) | 7.10 → 6.50 | 7.00 → 6.50 | 6.90 → 6.40 | **-7.2%** |
| 600 scroll steps, declared rows (`scroll-declared`) | 18.00 → 16.90 | 17.90 → 16.50 | 18.00 → 17.00 | **-6.1%** |
| 600 scroll steps, native flow (`scroll-native`) | 23.30 → 21.80 | 23.00 → 21.70 | 22.80 → 21.70 | **-5.7%** |
| 100 appends to 2,000 measured rows (`append-measured`) | 14.40 → 14.00 | 14.10 → 13.30 | 15.80 → 13.20 | **-5.7%** |
| 600 streamed updates, native anchoring (`stream-native`) | 33.90 → 34.10 | 34.00 → 33.30 | 34.10 → 33.10 | -2.1% |
| 300 single-item edits, 10,000 declared rows (`update-declared`) | 14.50 → 14.20 | 14.50 → 14.10 | 14.70 → 14.40 | -2.1% |
| 600 streamed updates, chat options (`stream-chat-options`) | 32.80 → 32.10 | 32.70 → 32.20 | 32.60 → 32.60 | -1.5% |
| Two-tier width resize, 1,200 measured rows (`width-resize`) | 400.10 → 400.10 | 400.00 → 400.10 | 400.00 → 400.00 | 0.0% |
| 600 scroll steps, runtime anchoring (`scroll-runtime`) | 31.40 → 31.50 | 31.60 → 32.60 | 31.50 → 31.40 | +0.3% |
| 600 scroll steps + 40 sticky refreshes (`sticky-headers`) | 23.90 → 25.10 | 24.40 → 24.20 | 24.10 → 24.20 | +0.4% |
| 30 prepends of 20 measured rows (`prepend-measured`) | 11.90 → 12.10 | 12.00 → 12.20 | 11.80 → 11.90 | +1.7% |
| 40 branch switches, 2,000 measured rows (`branch-switch-measured`) | 40.60 → 42.70 | 42.40 → 41.70 | 42.20 → 43.20 | +2.4% |
| 10 boots of 2,000 measured rows (`boot-measured`) | 21.70 → 22.10 | 22.00 → 23.40 | 23.10 → 25.30 | +6.4% |

## Clean code scan and reproduction

- **Reachability:** `pnpm dlx knip@6.39.0` reports zero issues.
- **Clones:** `pnpm dlx jscpd@5.4.0 src integrations demos examples --min-lines 8
  --min-tokens 65` reports zero TypeScript clones (`0.00%` across 71 TypeScript
  files).
- **Firefox 159 `about:memory` tooling fix:** `scripts/firefox-profile/memory-browser.mjs`
  now passes `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` to the temporary WebDriver BiDi
  profile environment so Firefox 159+ permits `about:memory` navigation during
  automated retention runs, and `scripts/firefox-profile/scroll-isolation.ts`
  matches both `const` and `let` `lastReconcile` declarations.

Reproduction commands:

```sh
node scripts/firefox-profile/runtime-ab.mjs --baseline=8bbef7c --browser=firefox --trials=3
node scripts/firefox-profile/runtime-ab.mjs --baseline=8bbef7c --browser=chromium --trials=3
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --cycles=4 --display=LU28R55 --output=browser-artifacts/perf-2x-2026-11-11/after-structures
node scripts/firefox-profile/runtime-retention.mjs --workload=mixed-natural --cycles=8 --display=LU28R55 --output=browser-artifacts/perf-2x-2026-11-11/after-mixed
pnpm run profile:chat -- --browser=firefox --mode=diagnostic --scenario=steady --steady-speed=fast --display=LU28R55 --output=browser-artifacts/perf-2x-2026-11-11/after-chat-diag
pnpm run profile:chat -- --browser=firefox --mode=timing --scenario=steady --steady-speed=fast --display=LU28R55 --output=browser-artifacts/perf-2x-2026-11-11/after-chat-timing
pnpm run profile:firefox -- --url http://127.0.0.1:4193/scripts/firefox-profile/fixtures/declared-rows.html --display=LU28R55 --live --down=5 --up=5 --ticks=60 --delta=48 --output=browser-artifacts/perf-2x-2026-11-11/after-ff-declared
pnpm run profile:firefox -- --url http://127.0.0.1:4193/demos/gallery/ --display=LU28R55 --live --layout=rows --down=4 --up=4 --ticks=45 --delta=36 --output=browser-artifacts/perf-2x-2026-11-11/after-ff-gallery
pnpm run profile:boot -- --url http://127.0.0.1:4193/demos/streaming/
```

Compact summaries, source hashes, commands, and `candidate.patch` remain under
ignored `browser-artifacts/perf-2x-2026-11-11/`, with all raw Gecko profiles,
`about:memory` dumps, temporary profiles, caches, and owned helper processes
removed. `ab-firefox.json`, `ab-chromium.json`, and
`after-structures/run-Obh5VF` ran on the final `candidate.patch`; the earlier
Firefox scroll and `mixed-natural` captures retain their exact measured
`reproduce.patch`, which differs only in the WebKit `!webkitCompositing` guard
and the positioned `updateItem` `place()` loop (neither executed in those
Firefox runs).

## Verification

- `pnpm run check` (Biome + `tsc --noEmit`): passed.
- `pnpm test`: 56 files, **5,702 unit tests** passed, including new tests for
  `KeyTable` high-load probing and deletion chains, `Geometry` copy-on-write
  height sharing and lazy `treeDirty`, `PositionedGeometry` segment-tree
  overlapping queries and `applyUpdateInPlace`, `ScrollSettle`
  `lowerBoundMaxScrollTop` interior layout elision, and positioned `updateItem`
  cross-item placement contracts.
- `pnpm run test:firefox-profile`: **202 portable checks** passed.
- `pnpm run build` and `pnpm run test:consumer`: passed.
- `pnpm run test:browser` and `pnpm run test:regression-runner`: passed.
- Three-browser regression suite (`runtime`, `gallery`, `photo-preview`,
  `newspaper`, `feed`, `history`, `shared`): **61 of 63 scripts passed** across
  Firefox, Chromium, and WebKit, including `runtime/native-animation` and
  `runtime/runtime-boundaries`; the remaining two (`runtime/chat-profiler` and
  `runtime/staged-row`) are pre-existing at `8bbef7c`.
