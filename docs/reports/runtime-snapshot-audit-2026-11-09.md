# Runtime snapshot performance and clean code audit, November 9, 2026

This audit profiles the runtime's hot paths at `437e93a`, fixes the snapshot
costs that grow with the list, and repeats the clean code scans. In Firefox,
appending to a measured list gets 44% faster, appending a declared page 66%
faster, booting a declared list 33% faster, and a mid-list declared change 20%
faster. Streaming and scrolling are unchanged: they were already bound by
browser layout. The scans find no unused or duplicated TypeScript.

## Conditions

The comparison uses Playwright Firefox 157.0 and headless Chromium
156.0.8078.4 on macOS 27.2. Firefox is the project's primary target. Each
browser loads the baseline runtime (`437e93a`) and the working tree side by
side in one page and alternates their order across 12 measured rounds after 2
warm-up rounds. Three independent trials run per browser.

The workloads are synthetic and headless. They measure JavaScript and layout
without paint, so display geometry does not apply. They make no claim about
physical presentation, native gesture timing, or demo boot time. No native
macOS capture ran, because no change touches the scroll or streaming paths.

## Profile findings

A Chrome DevTools Protocol sampling profile (50 µs interval) covers each
workload. Streaming and scrolling have no runtime hotspot: one forced layout
per streamed update costs about 46 µs, and the runtime's own JavaScript costs
a few microseconds per event. The snapshot paths, in contrast, did work
proportional to the whole list for every change.

| Finding | Cost at the baseline | Fix |
| --- | --- | --- |
| `KeyIndex.extend` copied the whole positions map for every append. | 67 µs per append to 2,000 keys | An append chain shares one map. The newest order adds only its new keys, and an older order ignores entries at or past its own length. An order that was already extended copies its own entries first. |
| `indexItems` copied every earlier key into a validation set when the first new key appeared. | About 0.3 ms per append to 10,000 keys | Check new keys against the matching prefix through its index and against each other in a set of the new keys only. Rejection order and messages are unchanged. |
| A declared snapshot committed heights one key at a time: three map probes and one tree walk per changed entry. | 8.7 ms of a 30 ms boot with 20,000 rows | `Geometry.declare` lands the snapshot's heights by position in one pass. It updates the tree in place for a few changes and rebuilds it in one linear fold for many. Only the rendered rows are visited for their own height. |
| The commit scanned every row for removed keys on any key change. | 30 µs per append to 2,000 rows | Skip the scan when the committed order precedes the new one: an append removes no row. |
| Three prefix scans per append compared every key again. | 22 µs per append to 10,000 keys | `KeyIndex.precedes` answers in constant time along an append chain. |

The declared commit no longer diffs against the previous snapshot, so
`DeclaredItems.forEach` loses its `unchanged` parameter and the comparison
code behind it.

## Interleaved comparison

Each cell is the median of 12 rounds, in milliseconds, baseline to candidate.
The delta is the median of the three trial deltas.

Firefox 157.0:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 100 appends to 2,000 measured rows | 50.70 → 28.46 | 50.28 → 28.36 | 51.64 → 29.18 | **-43.6%** |
| 50 pages of 40 appended to 10,000 declared rows | 85.94 → 29.00 | 84.44 → 28.58 | 86.02 → 30.30 | **-66.2%** |
| 10 boots of 20,000 declared rows | 79.36 → 53.44 | 71.70 → 53.76 | 76.10 → 50.66 | **-32.7%** |
| 50 mid-list height changes, 10,000 declared rows | 26.92 → 20.90 | 27.94 → 22.96 | 26.16 → 20.88 | **-20.2%** |
| 20 full relayouts, 10,000 declared rows | 19.08 → 17.36 | 23.00 → 16.78 | 18.88 → 17.10 | -9.4% |
| 50 unchanged `setItems`, 5,000 measured rows | 25.80 → 24.20 | 25.38 → 23.84 | 25.60 → 23.82 | -6.2% |
| 30 prepends of 20 measured rows | 21.40 → 19.72 | 21.18 → 19.46 | 18.98 → 19.02 | -7.9% |
| 600 streamed updates, native anchoring | 29.52 → 29.32 | 29.08 → 29.22 | 30.98 → 29.56 | -0.7% |
| 600 streamed updates, runtime anchoring | 30.98 → 30.72 | 30.44 → 30.84 | 30.78 → 30.82 | +0.1% |
| 600 scroll steps, native flow | 31.88 → 31.12 | 29.68 → 29.52 | 29.44 → 29.32 | -0.5% |
| 600 scroll steps, declared rows | 20.92 → 20.56 | 20.36 → 20.58 | 20.48 → 20.42 | -0.3% |
| 600 scroll steps, positioned cards | 12.72 → 12.48 | 12.38 → 12.44 | 11.82 → 11.96 | +0.5% |

Chromium 156.0.8078.4:

| Workload | Trial 1 | Trial 2 | Trial 3 | Median delta |
| --- | ---: | ---: | ---: | ---: |
| 100 appends to 2,000 measured rows | 27.30 → 13.80 | 32.20 → 14.50 | 30.70 → 12.20 | **-55.0%** |
| 50 pages of 40 appended to 10,000 declared rows | 50.00 → 13.00 | 52.00 → 13.60 | 50.00 → 13.00 | **-74.0%** |
| 10 boots of 20,000 declared rows | 31.30 → 24.10 | 31.80 → 23.40 | 30.40 → 22.60 | **-25.7%** |
| 50 mid-list height changes, 10,000 declared rows | 13.30 → 11.40 | 13.80 → 11.70 | 13.20 → 11.50 | **-14.3%** |
| 20 full relayouts, 10,000 declared rows | 6.50 → 6.00 | 6.80 → 6.20 | 6.40 → 6.20 | -7.7% |
| 50 unchanged `setItems`, 5,000 measured rows | 8.40 → 7.60 | 8.10 → 7.80 | 8.20 → 7.70 | -6.1% |
| 30 prepends of 20 measured rows | 13.60 → 13.70 | 12.70 → 13.20 | 12.30 → 12.80 | +3.9% |
| 600 streamed updates, native anchoring | 33.70 → 33.70 | 36.20 → 34.10 | 34.10 → 36.70 | +0.0% |
| 600 streamed updates, runtime anchoring | 42.50 → 41.80 | 39.50 → 39.10 | 38.80 → 38.60 | -1.0% |
| 600 scroll steps, native flow | 22.90 → 22.70 | 22.60 → 23.00 | 23.10 → 22.70 | -0.9% |
| 600 scroll steps, declared rows | 19.10 → 19.40 | 17.10 → 17.90 | 17.10 → 16.80 | +1.6% |
| 600 scroll steps, positioned cards | 7.30 → 7.80 | 7.20 → 7.40 | 6.70 → 6.80 | +2.8% |

The bold rows are the changed paths. The other rows are controls. Chromium's
prepend (+3.9%) and positioned scroll (+2.8%) deltas sit inside its
run-to-run spread: the unchanged native streaming path ranged from -5.8% to
+7.6% in the same trials. Firefox shows neither.

The absolute gains are small per call: about 0.2 ms per appended message at
2,000 rows, about 1.1 ms per appended page at 10,000 declared rows, and about
2.5 ms per boot of 20,000 declared rows in Firefox. They grow with the list.

## Candidates not changed

Two profiled costs stay, with reasons.

- **The measured staging loop.** `prepare` visits every key of a measured
  snapshot with two map probes (27 µs per append to 2,000 rows). Skipping
  items identical to the last snapshot would need a new invariant between
  `lastItems`, held work, and failed renders, and the loop repairs missing rows
  today. The gain is about 3 µs at a paged chat's size.
- **Hidden-row attribute writes at boot.** Clearing `inert` and `aria-hidden`
  on rows that are detached right after measurement costs about 0.5 ms per
  2,000-row boot, against 18 ms of layout.

## Clean code scan

The scans repeat the October 22 method on the changed tree.

- **Reachability:** `pnpm dlx knip@6.39.0` reports zero issues. With
  `--include-entry-exports` it lists the same 30 public type exports.
- **Clones:** `pnpm dlx jscpd@5.4.0 src integrations demos examples
  --min-lines 8 --min-tokens 65` reports zero TypeScript clones. The 12
  HTML and CSS matches are the demo page structure and the explicit and
  system dark-theme declarations recorded on October 22.
- **Members:** A reference scan of class members and option fields finds no
  member without a consumer in production code, tests, or tooling.

The audit removes the unused boolean result of
`FirefoxWheelPolicy.cancelCommit`, an array copy in `measureRows`, the
`Object.create` construction in `KeyIndex.extend`, and the
`Geometry.indexByKey` field that mirrored the key index.

Three items remain by decision, not by omission:

- `Geometry.isMeasured`, `Geometry.heightOf`, `Geometry.anchorAt`,
  `FenwickTree.size`, and the array form of `Geometry.setKeys` have no caller
  in the runtime. The kernel unit tests, the `data-structures` browser fixture,
  and the scroll-isolation profiler read them.
- `ScrollOptions.duration` is a documented, ignored compatibility field with
  no runtime code.
- The demo HTML and theme CSS repetition needs a visual check in each browser
  to remove.

## Reusable tooling

The comparison harness is in the repository. It extracts the baseline `src/`
tree under ignored `browser-artifacts/`, starts its own server and browser,
and removes all three when the run ends.

```sh
node scripts/firefox-profile/runtime-ab.mjs --baseline=437e93a
node scripts/firefox-profile/runtime-ab.mjs --baseline=437e93a \
  --browser=chromium --trials=1 --scenarios=append-measured,boot-declared
```

The workloads are in `scripts/firefox-profile/fixtures/runtime-ab.js`. The
harness accepts at most three trials.

## Verification and limits

These checks pass on the changed tree:

- `pnpm run check`.
- `pnpm test`: 56 files, 5,690 tests, including new coverage for the shared
  key index, bulk declaration, and tail validation.
- `pnpm run test:firefox-profile`, including the harness checks.
- `pnpm run test:consumer`.

No browser regression suite ran. Run `pnpm run test:browser -- --suite=chat`
and the declared-layout regressions before release. The measurements are
headless and synthetic; they do not show presentation smoothness.

Local-only reproduction metadata, the candidate patch, source hashes, and the
six trial summaries are in `browser-artifacts/audit-2026-11-09/`.
