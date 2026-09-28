# Runtime architecture performance round, September 28, 2026

This round follows the
[steady-scrolling audit](runtime-performance-audit-2026-09-28.md) from the
same day. It looks for costs that grow with the number of loaded items,
and it applies three runtime changes. The changes remove work that grows
with list size from streamed tokens, targeted updates, and width changes.
They don't change frame timing in the streaming demo, which keeps about
30 rows loaded. The gains apply to hosts with hundreds or thousands of rows.

## Conditions and evidence quality

Two kinds of evidence support this report, and they have different weight.
Read each number with its source in mind.

- **Native captures** used installed Firefox 156.0.1, build 20260921121718,
  with fresh temporary profiles and closed DevTools. The LU28R55 display used
  1920 × 1080 logical pixels at 2× and 60 Hz. The content area was
  1900 × 965.
- **Headless measurements** used Playwright builds of Firefox 155.0,
  Chromium 153.0.8010.12, and WebKit 26.6 against private Vite servers.
  Each page imported the baseline and the candidate runtime in the same
  session. Other jobs ran on the machine, so operation counts are the
  primary evidence and timings are secondary. Timings are medians of five
  alternating rounds.

Headless results aren't installed-browser or device evidence. No real Safari
or iOS run covers these changes.

## What the streaming profile shows

The baseline capture `firefox-timing-u5zAB5` ran the default
`pnpm run profile:chat` workload at revision `23867f4`: a 12-second stream
of 461 chunks into a chat with 160 turns of history, about 30 of them
loaded.

| Measure | Result |
| --- | ---: |
| Moving frames, p95 | 17.12 ms |
| Frames over 25 ms | 2, longest 33.6 ms |
| Content main-thread CPU | 3,792 ms, 18.9% of one core |
| Samples nearest to runtime code | 499 of 19,998, 2.5% |
| Of those, in `viewportState` | 389 |
| Of those, in `syncSkeletonSurface` | 7 |

`viewportState` reads `scrollTop` and `clientHeight` after the renderer
changes the streaming row, so its samples contain the layout of that change.
The layout is required; the read only decides when it runs.

The largest script cost is outside the runtime. The streaming trail in the
`markdown-viewer` dependency has 789 self samples in its top four functions:
`paint/geometry`, `readSourceSegments`, `paint`, and `acceptNode`. This
report records that cost and changes nothing in the dependency.

## Changes

All three changes are in `src/virtual-list.ts`. Each has unit tests that fail
on the previous runtime, a headless benchmark under `scripts/`, and, for two
of them, a browser regression.

### Incremental skeleton sync

With `scrollPlaceholders` on, every commit walked every loaded key, called
the host's `anchorable()` for each, and compared three style values per
skeleton. The guard that skipped the walk compared commit epochs, and every
commit advances the epoch.

The runtime now records what a commit changed: a structural flag, the keys
whose row was rendered or measured, and the lowest index whose height
changed. A commit with no such change returns at once. A height change
repositions only the skeletons from that index on. The skeleton box is held
as numbers, and built-in skeleton content is cloned from one element, so
creating a skeleton parses no data URL.

| Workload, skeletons on | Engine | Rows | Before | After |
| --- | --- | ---: | ---: | ---: |
| `anchorable()` calls per token | All three | 10,000 | 10,001 | 2 |
| Height-neutral token | Firefox | 100 | 86 µs | 30 µs |
| Height-neutral token | Firefox | 10,000 | 7,819 µs | 37 µs |
| Height-neutral token | Chromium | 10,000 | 5,447 µs | 22 µs |
| Every 20th token grows the row | Firefox | 10,000 | 8,046 µs | 202 µs |
| Enable the option | Chromium | 10,000 | 9,146 ms | 66 ms |

After the change, a height-neutral token costs the same with skeletons on
and off. Three limits remain:

- A height change at row *k* still writes the position of every later
  skeleton, and the engine lays out all skeleton boxes again. That worst
  case improves by 7% to 36%.
- Declared-height lists still walk every skeleton for each update.
- An `anchorable()` result that changes without a new item is seen at that
  row's next update or at the next structural commit, not at the next commit
  of any row.

### One-key declared updates

`updateItem` on a declared-height list copied the full declared map and
walked it at the commit. The pending state now carries only the touched
entry, marked by a `patch` flag, and the commit writes that entry into the
committed map. A snapshot from `setItems` still replaces the map.

| Measure per call, 10,000 rows | Before | After |
| --- | ---: | ---: |
| `Map.set` calls | 10,030 | 3 |
| Firefox, idle, same height | 1.303 ms | 0.030 ms |
| Firefox, inside a scroll phase | 1.890 ms | 0.027 ms |
| Chromium, idle, same height | 0.573 ms | 0.061 ms |

Counts are identical at 100, 1,000, and 10,000 rows in all three engines.
Geometry and mounted DOM match the previous runtime in all 27 combinations
of workload and size. No demo calls `updateItem` on a declared list, so this
change has no effect on the demos. Positioned lists keep the full rebuild.

### Two-tier width re-measurement

> **Warning:** This change relaxes a documented rule. While rows wait, their
> geometry reflects the old width.

A viewport width change attached, laid out, read, and detached every
rendered row in each `ResizeObserver` delivery. The runtime now reads only
the rows connected to the canvas. Detached rows wait in a set and are read
in one pass when one of these events occurs:

- The width has been unchanged for 150 ms.
- The row mounts.
- A scroll phase settles.
- A command takes over.
- A window job commits.

While rows wait, `state.held` is `true`. `totalSize`, `positionOf()`, and
the scrollbar thumb use old-width heights for those rows.

| Workload, 30 steps of 8 px | Engine | Rows | Before, per delivery | After, per delivery | Trailing pass |
| --- | --- | ---: | ---: | ---: | ---: |
| Plain rows, rows read | All three | 1,000 | 1,000 | 25 | 979 |
| Plain rows | Firefox | 1,000 | 19.2 ms | 0.22 ms | 19.6 ms |
| Plain rows | Firefox | 10,000 | 445 ms | 0.95 ms | 245 ms |
| Plain rows | Chromium | 1,000 | 25.7 ms | 0.1 ms | 27.7 ms |
| Rich rows | Firefox | 480 | 63.9 ms | 0.16 ms | 64.6 ms |

Every frame of each burst painted the same rows at the same coordinates as
the previous runtime, and the final geometry matched. Two limits remain:

- A single width step, such as a rotation, gains nothing. The same work
  runs 150 ms later.
- The trailing pass is one task. A sliced pass wasn't built.

`docs/core-contract.md` states the new rule. Two tests in
`tests/unit/virtual-list.test.ts` that read full-list geometry directly
after a width change now state it too.

## Native before and after

The repeat capture `firefox-timing-pazGju` ran the same streaming workload
with all three changes applied. Both captures delivered 461 chunks in
11,799 ms and recorded 703 moving frames.

| Measure | Before | After |
| --- | ---: | ---: |
| Moving frames, p95 | 17.12 ms | 17.26 ms |
| Longest frame | 33.6 ms | 33.3 ms |
| Frames over 25 ms | 2 | 3 |
| Content main-thread CPU | 3,792 ms | 3,651 ms |
| Samples nearest to runtime code | 499 | 378 |
| Samples in `viewportState` | 389 | 226 |
| Style flushes, count and total | 2,554, 632 ms | 2,292, 373 ms |

Frame timing is unchanged. The lower CPU and style totals come from one
pair of captures, so they don't establish a speedup. Regular
animation-frame callbacks don't prove smooth physical presentation. No
native capture covers a window resize or a large list with skeletons on.

## Candidates not applied

The discovery step ranked ten candidates and dropped six. Seven ranked
candidates stay out of the runtime:

| Candidate | Reason |
| --- | --- |
| Skeletons only in a band around the viewport | Changes documented behavior. Positions outside the band show nothing until the next scroll event. |
| Advance the epoch only when geometry changes | Narrows the rule that `onState` follows every commit. The remaining gain is tens of microseconds per token. |
| One pager submission per key per frame | Changes when the returned promise resolves. It helps only streams faster than the display rate. |
| Hold commits while the document is hidden | Geometry is stale while hidden. There's no gain for a visible document. |
| Conceal fast-scrolling rows without `inert` | Rows stay focusable while invisible. |
| Evict far offscreen measured rows | Element-local state is lost at eviction. |
| Start page loads by time to edge | Changes the reach rule and starts loads earlier. |

The dropped ideas were tested and rejected in earlier reports, or their best
case was too small to measure. They include an incremental `setKeys`, native
sticky headers, deferred token measurement, and cached wheel-edge geometry.

## Verification

The combined changes pass `pnpm run check` and all 1,133 unit tests, 59 of
them new. Browser regressions were run for each change alone, and the
runtime group was run once on the combination.

| Check | Scope | Result |
| --- | --- | --- |
| Runtime group | Combined changes | 32 of 32 |
| Runtime group | Each change alone | 30 of 30, 30 of 30, and 30 of 31 |
| Chat-scrolling group | Skeleton sync, width change | 17 of 17 each |
| Newspaper, gallery, feed, history | Declared updates | 12 of 12 |
| Chat invariants, three engines | Skeleton sync | 0 violations |

The one failure was `runtime/hidden-row` with the skeleton change. It passed
in nine isolated repeats, three of them on the previous runtime, and it
doesn't enable skeletons. No independent review of these changes was
completed.

## Reproduce

The headless benchmarks compare `/src` with a copy of the previous runtime
that the same server serves. To repeat a comparison, follow these steps from
the repository root:

1. Create the copy before you start the server. Vite versions the imports
   of a file that changes while it runs, and the counters then wrap a second
   module instance.

   ```sh
   git worktree add --detach ../virtual-list-baseline 23867f4
   cp -R ../virtual-list-baseline/src baseline-src
   ```

2. Start a private server.

   ```sh
   pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
   ```

3. Run the benchmark for the change you want to measure. The comment at the
   top of each script lists its options.

   ```sh
   node scripts/skeleton-benchmark.mjs --url=http://127.0.0.1:4193 \
     --baseline=/baseline-src
   node scripts/declared-update-benchmark.mjs --url=http://127.0.0.1:4193 \
     --baseline=/baseline-src/virtual-list.ts
   node scripts/width-resize-benchmark.mjs --url=http://127.0.0.1:4193 \
     --baseline=/baseline-src/virtual-list.ts
   ```

4. Remove `baseline-src` before you run `pnpm run check`.

To repeat the native streaming capture, run the chat profiler on the affected
display:

```sh
pnpm run profile:chat -- --browser=firefox --display=LU28R55 --mode=timing
```

Compact capture summaries remain under ignored
`browser-artifacts/chat-profile/`. The runner deleted the raw profiles.
