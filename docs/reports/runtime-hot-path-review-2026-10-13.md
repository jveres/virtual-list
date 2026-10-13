# Runtime hot-path review, October 13, 2026

This review reads the runtime's hot paths (streaming commits, scroll events,
and declared snapshots), profiles them, and removes duplicated or allocating
code where a comparison shows a gain or no loss. The streaming and scroll
paths are already close to their floor: browser layout at required read points
dominates, and the runtime's own JavaScript costs a few microseconds per
event. Declared-height `setItems` gets 10% faster at rest and 15% faster
during a scroll phase. `src/` shrinks by 73 lines.

## Conditions

The review starts at revision `1d9660f`. Firefox is the project's primary
target, but this review uses headless Chromium 153.0.8010.12, because
Playwright Firefox does not launch inside the agent sandbox. The workloads are
synthetic and measure JavaScript and layout without paint. They make no claim
about physical presentation or native gesture timing. The comparison page
imports the HEAD runtime and the working tree side by side, against the
running development server, and alternates their order in each round.

## Profile of the hot paths

A Chrome DevTools Protocol sampling profile (50 µs interval) covers six rounds
of 600 operations on a 2,000-row measured list:

- **Streaming `updateItem` at rest:** The one forced layout per update happens
  in `viewportState` at the start of the commit, after the host render. The
  row measurement needs it, and it costs about 60 µs per update. The read
  after the commit's writes costs about 2.5 µs, because only the slot height
  is dirty. Garbage collection costs about 5 µs per update.
- **Scroll events:** `handleScroll`, reconciliation, mounting, and the spacer
  layout together cost a few microseconds per event. The remaining time
  belongs to the workload's own scroll writes and to row layout.

Neither path has a redundant layout read or a runtime JavaScript hotspot left
to remove.

## Changes

Each change is independent and keeps the commit rule and anchoring unchanged.

| Change | Effect |
| --- | --- |
| `DeclaredItems.holdsAt` replaces `snapshotEntry` | The unchanged-entry skip allocates nothing; a 10,000-entry scan falls from 104 to 75 µs. |
| `confined()` scans declared heights with `forEach`; the generator iterator is removed | No per-entry tuples; a 10,000-entry scan falls from 385 to 276 µs. |
| `Geometry.capture` clamps the viewport once | One object instead of two spread copies; 73 → 62 µs per 1,000 captures. |
| `FenwickTree.append` continues the constructor's linear fold | O(added + log n) instead of O(added · log n), with less code. Time is unchanged, because copying the array dominates. |
| `KeyIndex.prefixes` is shared by `extend` and `Geometry.setKeys` | Removes the duplicate prefix loop and the size heuristic that the linear append made obsolete. |
| `commitHeight` skips the style write when the height is unchanged | A shown slot always carries `row.height`; most streaming tokens keep it. |
| `reflow()` builds the internal-reflow commit options | Replaces six copies of the same option object. |
| `stageSnapshot` adds edge-slot keys in place; `sameKeys` is inlined; duplicate `clientHeight` comment merged | Less code; one fewer key-array copy per snapshot. |

## In-page comparison

Each scenario runs 13 measured rounds after one warm-up round. The table
reports median totals per round.

| Scenario | HEAD | Candidate |
| --- | ---: | ---: |
| 600 streaming `updateItem` calls, 2,000 measured rows | 87.8 ms | 88.1 ms |
| 600 synthetic scroll events, 2,000 measured rows | 126.9 ms | 122.4 ms |
| 200 `setItems` calls at rest, 10,000 declared rows | 80.0 ms | 72.3 ms |
| 200 `setItems` calls during a scroll phase, 10,000 declared rows | 118.9 ms | 101.5 ms |

The streaming and scroll rows are equal within run-to-run noise: an earlier
7-round run varied by up to 19% on the unchanged scroll path. Three runs
reproduced the declared reductions.

## Verification and limits

`pnpm run check` and all 5,672 unit tests pass. The kernel tests cover random
appends against a fresh tree, so they cover the new append fold. No browser
regression suite ran in this review; run `pnpm run test:browser --
--suite=chat` before release. The declared gains apply to declared-height
snapshots, which the demos submit on paging rather than per frame. Firefox
timings are not measured here.

Reproduction metadata, the candidate patch, source hashes, the probes, and
their results are in the ignored folder `browser-artifacts/hot-path-2026-10-13/`.
To recreate the baseline module, run
`git archive 1d9660f src | tar -x -C browser-artifacts/hot-path-2026-10-13/baseline-src --strip-components=1`.
