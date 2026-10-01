# Runtime investigation progress, October 2, 2026

The [pixel-ratio comparison](runtime-pixel-ratio-2026-10-02.md) retains one
verified gain over `v0.4.9`, revision
`01f9cdea881561225205ca539b58350bbdac9acc`: median large positioned edits improve
from 49 to 45 ms in two fresh candidate captures. Compact snapshots, bulk
paging, and sustained memory remain under investigation.

## Measurement status

The attempted fresh baseline used the existing structures diagnostic:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --output=browser-artifacts/pixel-ratio-baseline
```

`run-GFrZXi` stopped with `Desktop is locked` before browser launch. It has zero
checkpoints and no cleanup errors. It is invalid evidence and consumes no valid
comparison trial. Compact metadata and the reproduction patch remain under
ignored `browser-artifacts/pixel-ratio-baseline/`. No raw profile was captured.

The desktop was subsequently unlocked. The three valid pixel-ratio captures
and the first 120-cycle paging capture use Firefox 157.0, build 20260924084938,
with LU28R55 at 1920 × 1080 logical pixels, DPR 2, and 60 Hz. The outer window
is 1900 × 1049 at `(1450, 31)`, with a 1900 × 964 content area.

## Candidate status

The four investigations from the data-structure audit have these dispositions:

| Candidate | Evidence and next measurement |
| --- | --- |
| Read the device pixel ratio once per synchronous declaration pass. | Retained after baseline, candidate, and repeat. Large positioned edits improve about 8%, and structural batches improve 4–6%. No retained-memory or GC gain is claimed. |
| Compact declared-item snapshots. | A full declared snapshot still allocates a `Map<string, { item, height }>` alongside its key index. Measure aligned item and height storage while preserving constant-time individual edits and independent pending/committed ownership. No candidate is implemented. |
| Bulk paging with overlap, cancellation, and eviction. | The first installed-Firefox capture passes 120 cycles per case. Median page loads are 2 ms at a 480-item budget, 5 ms for 2,000 positioned items, and 16 ms for 10,000 stacked items. Matched comparisons and attribution remain open. |
| Sustained mixed-workload memory and natural GC. | The first capture records natural process samples and GC slices without diagnostic tabs or forced collection between cycles. Comparison with compact snapshots remains open. |

The ratio experiment's original patch and hashes are preserved locally under
`browser-artifacts/runtime-pixel-ratio-experiment/`. The retained change doesn't
cache the ratio between updates or skip host height and position callbacks.

## Prepared validation

The ratio candidate passes 5,643 unit tests, static checks, 190 portable
profiler checks, and the pixel-grid browser regression. Its added unit coverage
checks ratio changes between snapshots and individual edits. Performance
evidence comes from the separate matched Firefox captures.

The new [paging workflow](../memory-profiling.md#exercise-sustained-paging-without-forced-collection)
provides reusable fixtures, an installed-Firefox runner mode, and a separate
headless correctness regression. All three cases pass twelve cycles in
Firefox, Chromium, and WebKit, including release checks. The installed-Firefox
baseline `paging-natural-baseline/run-PoKAwP` also passes all three 120-cycle
cases, with thirty cancelled loads per case, and no cleanup errors. Its compact
summaries remain under ignored `browser-artifacts/`.

After each measured candidate, retain only a repeatable gain that justifies its
complexity, run the required repository and browser checks, and publish a patch
release if runtime behavior changes. Record rejected candidates too. This round
is complete only after each open candidate has a measured disposition or an
explicit scope limitation.
