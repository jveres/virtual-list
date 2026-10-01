# Complete runtime performance audit, October 1, 2026

There are remaining opportunities, concentrated in width-resize completion and
operations over large retained windows. The review does not identify another
high-impact change for ordinary scrolling. Two installed-Firefox captures
reproduce the remaining costs; no production optimization is implemented or
claimed by this audit.

The subsequent [implementation comparison](runtime-boundary-optimizations-2026-10-01.md)
retains resize batching and a cheaper pin scan. It rejects the positioned,
edge-slot, and pager prototypes after comparison with a restored control.

The scope is every file under `src/`, including optional companions, plus the
existing performance evidence. The new fixture measures paths that steady
scrolling and streaming profiles do not adequately exercise. Demo rendering,
dependency internals, network loading, and physical display presentation are
outside this source audit.

## Remaining opportunities

### 1. Slice the detached-row work after a width change

`invalidateHeights` promptly dirties mounted rows and leaves detached rows for
the quiet-width timer. However, `drainStale` then moves **all** stale rows into
one synchronous commit. `readHeights` connects and measures that entire set.
See [the drain](../../src/virtual-list.ts#L774) and
[height reads](../../src/virtual-list.ts#L853).

In the new synthetic paragraph workload, changing the viewport width from
1,100 to 650 CSS pixels gives these results:

| Retained measured rows | Largest frame gap, trial A | Largest frame gap, trial B |
| --- | ---: | ---: |
| 480 | 99.76 ms | 83.02 ms |
| 1,000 | 166.68 ms | 167.16 ms |

Each resize phase has exactly one interval above 25 ms. The profiler also
records long timer callbacks containing synchronous reflow, and attributes
samples to `awaitQuietWidth` → `drainStale` → `commit` → `readHeights`.
The timer callbacks take 96.95/85.81 ms for 480 rows and 165.05/168.63 ms
for 1,000 rows in trials A/B; nested reflow accounts for most of each callback.
These are main-thread stalls in the resize phase, separate from initial row
construction. All rows finish with verified heights and contiguous offsets.

This is the highest-priority runtime candidate when large measured histories
must survive resizing. Prototype bounded background batches for detached rows,
keeping newly visible rows urgent and preserving reading anchors. Measure both
the largest task and total layout work: smaller batches can increase total
work. Commands currently force exact geometry by draining stale rows before
resolving their target; preserving that guarantee can still leave a synchronous
cost on an immediate command. Reducing the retained measured window is an
existing integration-level alternative.

The [September 28 architecture audit](runtime-architecture-performance-2026-09-28.md)
already identified the trailing pass in headless measurements. These captures
confirm that it remains material in the installed Firefox on the external
display. They do not measure dragging the OS window continuously.

### 2. Give positioned content edits a narrower update path

[`updateItem`](../../src/virtual-list.ts#L2247) copies `lastItems` and invokes
the full snapshot pipeline whenever the `position` option exists. Even an edit
that changes only a label revalidates all keys and heights, reevaluates every
placement, and constructs a new lane index.

At 10,000 items, the median call is **5 ms in both trials**. Sixty edits invoke
`height` and `position` 600,000 times each, while rendering only the 60 changed
rows. The equivalent stacked case calls `height` 60 times and has a median
below the fixture's 1 ms timing resolution.

A content-only update that explicitly preserves placement could reuse geometry.
This needs a clear host contract: callbacks can depend on shared layout state,
so checking only the edited item's returned position cannot establish that all
other positions remain unchanged. The fixture uses one ordered lane with
unchanged positions; it establishes unnecessary work for that use case, not a
speedup for every masonry update. This candidate matters for frequent edits in
large positioned lists, not ordinary scrolling through a fixed gallery.

### 3. Avoid restaging ordinary rows for edge-slot changes

[`setEdgeSlot`](../../src/virtual-list.ts#L2965) copies the full item array and
calls `applyItems`. Alternating an end loader on and off therefore reevaluates
all host keys and declared heights even though no ordinary row changes.

At 10,000 items, the median is **7 ms in both trials**, with 600,000 height
callbacks for 60 slot changes and zero ordinary-row renders. A specialized
slot transaction could reuse existing row declarations and avoid full row
preparation. Adding or removing a slot still changes geometry keys, so the
current Fenwick rebuild can remain linear; this is not a proven constant-time
optimization. Preserve held updates, pins, rollback, and positioned origins.

Loader changes are normally infrequent. The fixture deliberately repeats them
once per frame to expose their cost; it does not represent normal paging
frequency. Prioritize this after resize work unless an application frequently
changes boundary UI with a large retained window.

### 4. Treat declarative pin scans and large live pagers as conditional costs

[`selectPin`](../../src/virtual-list.ts#L1108) searches backward for the last
matching item on every update. With no match, 60 edits at 10,000 items call the
predicate 600,000 times. Median time is 3 ms in trial A and 1 ms in trial B;
the magnitude is variable, but the full scan is deterministic. Prefer an
explicit command pin when that expresses the integration's intent. A cached
predicate result would need an invalidation or purity contract because the
predicate may close over changing state. The demos do not currently configure
this declarative predicate.

[`updateItemLive`](../../src/paging.ts#L236) still scans retained source items
and page ownership and copies exposed source data. The one-page 10,000-item
case has a 1 ms median in both trials, including the runtime submission. At
1,000 items its median is below 1 ms. This is lower priority than the findings
above, and the existing bounded chat window has much less exposure. The
[September 14 measurements](runtime-candidate-measurements-2026-09-14.md)
already found no repeatable end-to-end benefit from a smaller pager copying
change. An indexed-owner redesign needs evidence from a real large pager,
including overlaps and eviction, before it is worth the added state.

## Coverage of the rest of the runtime

The following review covers all source files and the principal branches inside
the main runtime. “No new candidate” means none justified by this review and
available measurements, not a proof that further improvement is impossible.

| Area and source | Assessment |
| --- | --- |
| `fenwick.ts` | Linear construction, logarithmic prefix/search/update, cached total. Structural key changes rebuild by design. No new candidate for ordinary height edits. |
| `geometry.ts` | Indexed keys and heights; incremental height deltas; explicit anchor, pin, reserve, and removed-anchor handling. Arbitrary snapshot replacement still requires whole-sequence work. No new measured target beyond structural operations above. |
| `positioned-geometry.ts` | Lane indexes, binary search, cached windows, and entering/leaving deltas are already present. Overlap and anchor-predicate fallbacks can scan more items; their general semantics prevent assuming ordered, pure inputs. Rebuilding on content edits is finding 2. |
| `virtual-list.ts`: DOM ownership and reconciliation | Measured rows retain their DOM by key; declared rows render the visible/overscan window. Cached epochs/ranges and mounted-row work avoid full-list scroll scans. The separate pooling experiment does not establish a total CPU saving. |
| `virtual-list.ts`: measured updates and observers | Dirty-row batching and incremental geometry updates are present. Reads after host writes can force layout. Detached width invalidation has the confirmed trailing stall in finding 1. |
| `virtual-list.ts`: `setItems`, `updateItem`, `updateWindow` | Full replacement necessarily validates a snapshot; stacked item edits use the existing one-key path. Asynchronous preparation yields in bounded slices, cancels obsolete jobs, and retries width/source changes. An indivisible expensive host render or staging step can exceed the slice target; increasing the row cap was already rejected by measurement. |
| `virtual-list.ts`: publication, follow, commands, reentrancy | Geometry reads and host callbacks are ordered around commits; reentrant work and host errors have explicit handling. No new measured saving justifies changing those ordering guarantees. Immediate commands can inherit stale-height draining cost. |
| `virtual-list.ts`: initialization and disposal | Measured initialization reads all retained rows; declared mode materializes a window. This audit does not add a boot benchmark. Disposal cancels jobs, timers, observers, motion, and listeners and destroys owned rows. The fixture verifies canvas removal. Holding a disposed API can still retain snapshot/geometry metadata; no new heap-retention measurement was performed. |
| `scroll-settle.ts`, `wheel-policy.ts` | Browser-specific input, native scroll-end, cooldown, edge release, pointer/touch, and programmatic-write handling reviewed. Existing profiles show little timer cost. Earlier timer substitutions changed required settle ordering; no new justification to repeat them. |
| `native-glide.ts`, `viewport-repaint.ts` | Native motion owns animation; completion/cancellation and the WebKit replacement repaint have bounded lifetimes. No new candidate. The October 1 navigation fix was in demo orchestration. |
| `follow.ts`, `reach.ts` | Small policy/state calculations, edge hysteresis, and explicit request lifetimes. Host geometry callbacks can carry layout cost, already accounted for at runtime boundaries. No new candidate. |
| `paging.ts` | Whole-page ownership, deduplication, protected eviction, revision retries, cancellation, and head refresh require structural work. Under-budget reconciliation has an allocation-free early return. Large live edits are finding 4. |
| `companions/sticky-headers.ts` | Header refresh is linear in headers; scroll selection uses binary search and a small number of transforms. Earlier refresh/style-guard measurements found little headroom. No new candidate. |
| `companions/reading-anchor.ts` | Snapshot reads occur on discrete actions; replacement mapping scans supplied replacements. No per-frame layout loop. |
| `companions/styles.css`, `types.ts`, `index.ts`, `companions/index.ts` | One visibility rule and declarations/exports; no additional runtime loop or substantial layout structure. |

The [September 30 native audit](runtime-performance-audit-2026-09-30.md) remains
the evidence for ordinary declared scrolling, gallery scrolling, rich paging,
and streaming. This audit rereads the current source but does not repeat those
four workloads. The [CSS review](css-layout-performance-2026-09-29.md),
[fast-scroll comparison](fast-scroll-exploration-2026-09-29.md), and
[pooling comparison](declared-pooling-2026-10-01.md) do not justify another
generic containment, layer, or recycling patch. The separate
[web research](virtualization-web-research-2026-10-01.md) describes broader
renderer and virtualization experiments whose tradeoffs remain unmeasured.

## Measurements and reproduction

Both trials use revision `77e1d1839d536693be98ec050b73f37190938df5` with the
captured working-tree patch. Production source is unchanged. The retained
fixture is [runtime-boundaries.js](../../scripts/firefox-profile/fixtures/runtime-boundaries.js).
Each edit case uses 10 warmup operations, then 60 timed operations, one per
animation frame, at 1,000 and 10,000 retained rows. Declared rows are 80 pixels
high, overscan is 400 pixels, and edits target the visible middle row. The
resize cases use identical rows with eight wrapping paragraphs each; heights
change from 569 to 889 pixels. Every final row offset and height is checked.

The table gives median/p95 wall time in milliseconds. Values below 1 ms are
reported as `<1` because Firefox's page timer in this fixture resolves to
integer milliseconds. These include small callback counters and host text
updates; they are API wall times, not isolated runtime CPU measurements.

| Operation | 1,000 rows, A | 1,000 rows, B | 10,000 rows, A | 10,000 rows, B |
| --- | ---: | ---: | ---: | ---: |
| Stacked `updateItem` | 1 / 2 | <1 / 1 | <1 / 1 | <1 / 1 |
| Positioned `updateItem` | 1 / 2 | 1 / 2 | 5 / 10 | 5 / 6 |
| Declarative pin with no match | <1 / 1 | <1 / 1 | 3 / 9 | 1 / 2 |
| Pager live update, one retained page | <1 / 1 | <1 / 1 | 1 / 5 | 1 / 2 |
| Add/remove end slot | 1 / 2 | 1 / 2 | 7 / 10 | 7 / 9 |

Whole-recording maxima include setup and disposal; they are not evidence that
an individual API always costs that much. The table
uses only timed operations, and resize gaps use only the marked resize phase.
The fixed case order also means these are not cold-code scaling curves.

Environment: installed Firefox 157.0, build `20260924084938`, fresh temporary
profile, DevTools closed; macOS 27.0; LU28R55 at 1,920×1,080 logical pixels,
2× scaling, 60 Hz. Browser outer size is 1,900×1,049 at (1,450, 31), content
size 1,900×964. The scroll viewport is 924 pixels tall and initially 1,100
pixels wide.

```sh
pnpm exec vite --host 127.0.0.1 --port 4194 --strictPort
pnpm run profile:firefox -- --display=LU28R55 --refresh-hz=60 --live --layout=none --url=http://127.0.0.1:4194/scripts/firefox-profile/fixtures/runtime-boundaries.html --output=browser-artifacts/runtime-boundaries --idle-seconds=30 --warmup-ms=2000
```

Run the capture command twice, sequentially. Local-only run IDs are
`run-m5Zah8` and `run-L4RvHU`; compact results and comparison metadata are under
ignored `browser-artifacts/runtime-boundaries/`. Each capture records 17 scroll
events and 19 scroll-end events, with automatic middle-row navigation and resize
anchoring. This is an
API/resize workload, using the runner's automatic mode; it is not native wheel
or trackpad-momentum evidence. Frame samplers read timestamps and cached state,
not DOM layout. Regular callbacks do not prove smooth physical presentation.

The two trials establish repeatable opportunities, not the benefit of a patch.
No third trial was added. Raw captures and temporary browser profiles are
removed after analysis; reproducible source patches, hashes, commands, browser
build, display geometry, and compact summaries remain locally.

## Verification

The fixture verifies committed edits, unchanged item positions, expected total
height, source updates through the pager, width reflow of every row, completion
of held work, and canvas removal on disposal. Its browser regression exercises
the same assertions without treating automation timing as native performance:

```sh
pnpm run check
pnpm test
pnpm run test:firefox-profile
pnpm run test:regression -- --group=runtime --match=runtime-boundaries
```

All checks pass: 5,624 unit tests, 185 portable profiler checks, and the new
fixture regression in Firefox, Chromium, and WebKit. `check` reports only the
two existing `!important` warnings in diagnostic CSS; the unit suite retains
the existing dependency source-map warnings.
