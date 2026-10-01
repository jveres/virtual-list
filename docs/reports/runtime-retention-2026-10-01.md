# Runtime source retention, October 1, 2026

The lifecycle investigation finds two unnecessary ownership paths and fixes
both. List and pager configuration kept their initial source data after
replacement or eviction. A disposed list also kept its last desired item
snapshot while its API handle remained referenced. Old rendered row roots
were already collected correctly in this workload.

The comparison below uses installed Firefox with explicit garbage and cycle
collection. These are reported window-allocation bytes, not whole-browser RAM
or scrolling-speed measurements. Each active case ends with 96 items.

| After twelve cycles | Original window MiB | Fixed window MiB | Original reachable items | Fixed reachable items |
| --- | ---: | ---: | ---: | ---: |
| Replace the conversation within one list | 11.214 | 6.705 | 192 | 96 |
| Load and evict source pages | 8.132 | 6.639 | 128 | 96 |
| Dispose and release each API handle | 1.659 | 1.667 | 0 | 0 |
| Dispose but keep twelve old API handles | 56.361 | 2.242 | 1,152 | 0 |
| Release those twelve old handles | 1.663 | 1.671 | 0 | 0 |

The largest reduction is **54.12 MiB**, conditional on keeping twelve disposed
handles. That scenario deliberately amplifies the ownership problem; it is
not a claim that ordinary chat navigation leaks 54 MiB. The normal dispose
and release case already collects all tested source items and row roots.

## What retained the source data

The original list captured the entire creation options object in its live
methods. `options.items` therefore kept the initial item array even after
`setItems` replaced every item. After twelve replacements, weak references
showed exactly the first and final generations surviving: 96 items each.
Only the final generation's 96 rendered row roots remained.

The pager also captured `options.initial`. Its first page survived eviction
even though `pages` and `items` correctly advanced. The combined list/pager
case retained the initial 32 items plus the final three 32-item pages. All
320 evicted row roots were collected.

Disposal destroyed the rows but left the list's `lastItems` array reachable
through the API closure. With old handles retained, item counts grew exactly
with the number of disposed lists: 384 after four, 768 after eight, and 1,152
after twelve. Rendered row roots were zero at each checkpoint. Releasing the
handles collected all source items in the original runtime too.

## Retained changes

[`createVirtualList`](../../src/virtual-list.ts) now separates `initialItems`
from the configuration captured by live methods, and clears `lastItems` on
disposal. [`createPagedWindow`](../../src/paging.ts) separates `initial` from
its captured configuration. Neither change mutates the caller's input object
or array. Creation now copies top-level configuration properties; nested
configuration objects, including declarative pin offsets, remain referenced.

Disposed APIs still retain configuration, geometry, and small lifecycle
objects. In this fixture, twelve fixed disposed handles account for roughly
0.57 MiB more window memory than releasing them. Hosts should release handles
when finished; this patch removes source payload retention, not every byte
associated with an API object. Host callbacks or stores can independently keep
items alive.

The fix does not alter the measured-row DOM cache while a row belongs to the
loaded source window. Active cases retain their 96 rendered roots. It also
does not add a new disposal notification or change the final numeric state
and geometry queries.

## Workload and measurement

The reusable [fixture](../../scripts/firefox-profile/fixtures/runtime-retention.js)
creates 96-item conversations. Each item contains a distinct, flat, deterministic
32 KiB string. Each measured row renders six paragraphs from short excerpts and
has a listener referencing its item. There are no images, Markdown parsing,
storage, network responses, or private inputs. Payloads make source ownership
visible; the absolute saving scales with actual source data and engine string
allocation.

Four phases each run twelve cycles in one document:

1. Replace all 96 items, then visit the end and start.
2. Load twelve 32-item pages into a 96-item pager budget, moving to the end
   and reconciling eviction. The initial page plus twelve fetched pages
   create 416 items; 320 are evicted and 96 remain active.
3. Create, traverse, and dispose twelve lists, dropping each API handle.
4. Repeat while intentionally keeping the twelve disposed API handles, then
   release all handles.

Both captures record identical travel and event counts. The replacement and
both disposal phases each traverse 698,976 CSS pixels and record 24 scroll
events and 24 scroll-end events. Paging traverses 29,124 pixels, records 13
scroll and scroll-end events, and evicts 320 items. Commands use instant API
scrolling; this is an allocation and ownership workload, not native wheel or
trackpad-momentum evidence. No animation-frame layout sampler is used.

The runner records physical footprint before collection, requests Firefox's
`minimizeMemoryUsage`, gathers memory-report leaves, and reads weak references
in a separate page task. It sums the fixture's `explicit/window-objects/top`
subtree without adding overlapping global totals. Mozilla documents the
[reporter tree and collection controls](https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html).
Only aggregate counts and byte totals cross into the retained summaries;
automation never receives source objects or DOM handles.

Content-process `heap-allocated` corroborates the ownership result. It changes
from 18.69 to 14.17 MiB after replacement, 15.69 to 14.18 MiB after paging, and
63.73 to 9.65 MiB with twelve disposed handles retained. The reported GC-heap
metric was unavailable and remains `null`. Process footprints include browser
caches, allocator capacity, graphics, and shared accounting; this report does
not treat them as exact per-tab costs or infer a natural memory plateau from
forced collection.

The empty fixture starts near 0.70 MiB. After workload warmup and release it
sits near 1.67 MiB in both captures. Fixture-owned weak-reference records,
code, and browser state contribute to that floor. A small increase in this
floor does not establish a runtime leak.

## Reproduction and conditions

Original revision: `d10023c3f9845bdd32f6f32d0f453a73830cab38` (`v0.4.7`).
The fixed run uses that revision plus the recorded source patch. Both use
Firefox 157.0, build `20260924084938`, on macOS 27.0.1, build `26A434`, with
fresh temporary profiles and closed DevTools.

The LU28R55 is 1,920 × 1,080 logical pixels, 2× scaling, and reports 60 Hz.
The browser outer window is 1,900 × 1,049 at (1,450, 31); content is
1,900 × 964. The scroll viewport is 1,100 × 924. Geometry matches exactly.

```sh
node scripts/firefox-profile/runtime-retention.mjs --cycles=12 --display=LU28R55
```

Two valid captures were sufficient for this ownership comparison. Local-only
run IDs are `run-C6V4VE` (original) and `run-jDajVz` (fixed), under ignored
`browser-artifacts/runtime-retention/`. Their full runner durations, including
helper compilation and browser startup, are 69.69 and 70.90 seconds. These
durations are not performance results. `comparison.json` joins the checkpoints;
each run retains its command, revision, source hashes, and reproduction patch.

The fixture JavaScript, collection runner, and collection helper have identical
bytes in both captures. The fixed run removes an unused `tabindex` from the
fixture's viewport to satisfy linting; geometry, rendering, and commands are
unchanged. Regression assertions and an analyzer check also change, but do not
execute in the measured page. The only production changes are the ownership
fixes in the list and pager.

An earlier attempt, `run-0cQnhM`, failed before its first checkpoint because
the analyzer did not normalize Firefox's escaped URL separators. It is invalid
evidence. The analyzer now handles these paths and has a portable check.

All owned browsers, servers, native helpers, temporary profiles, and per-run
compiler caches are closed or removed. Raw memory-report rows are reduced in
memory; no heap dump or raw capture is retained or uploaded.

## Verification and limits

`pnpm run check` passes with the two existing diagnostic CSS warnings.
All 5,631 unit tests and 187 portable profiling checks pass. Initial sandboxed
attempts blocked loopback servers in existing relay/profiler tests; the same
suites pass with local socket access.

The new `runtime-retention` regression passes lifecycle checks in Firefox,
Chromium, and WebKit. Chromium additionally forces collection through CDP and
asserts that only active source items and row roots remain, then that releasing
all handles leaves zero. Installed Firefox provides the primary before/after
memory evidence. No garbage-collection timing assertion is made for WebKit.

The existing `chat-lifecycle` regression passes in Firefox, covering transcript
replacement during a request and a delayed provider-history read. Its storage
setup logs two Vite `Invalid URL` diagnostics; its lifecycle assertions pass.
The existing `stream-paging` regression passes in Firefox, Chromium, and WebKit,
with an older page committing while a reply is still streaming.

This is a bounded synthetic lifecycle test. It does not audit IndexedDB,
conversation-tree stores, Markdown renderer caches, images, aborted external
fetch implementations, browser back/forward caches, or hour-long natural GC
behavior. It does not establish a frame-time improvement or a whole-browser
memory percentage. Those remain separate workloads if symptoms implicate them.
