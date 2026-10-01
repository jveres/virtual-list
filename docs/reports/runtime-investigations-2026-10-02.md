# Runtime investigation progress, October 2, 2026

The [pixel-ratio comparison](runtime-pixel-ratio-2026-10-02.md) retains one
verified gain over `v0.4.9`, revision
`01f9cdea881561225205ca539b58350bbdac9acc`: median large positioned edits improve
from 49 to 45 ms in two fresh candidate captures. The subsequent
[declared-snapshot comparison](runtime-declared-snapshots-2026-10-02.md) reduces
that median to 28–29 ms and removes about 7.1 MiB of loaded fixture-window
storage at 100,000 items. Bulk paging and sustained memory remain under
investigation.

The verified changes are published as
[v0.4.10](https://github.com/jveres/virtual-list/releases/tag/v0.4.10) and
[v0.4.11](https://github.com/jveres/virtual-list/releases/tag/v0.4.11). The latter
release is revision `3f64f33cdd0e3a2ccad8a68edd6eeb5a8bd7049c`.

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

After publishing v0.4.11, the next paging baseline attempt,
`paging-compact-baseline/run-palIXO`, stops before browser launch because the
desktop is locked again. It has zero checkpoints and no cleanup errors, so it
is excluded. A separate console-state check confirms the lock. The remaining
comparisons require the desktop to be unlocked; the source is restored to the
released version while waiting.

## Candidate status

The four investigations from the data-structure audit have these dispositions:

| Candidate | Evidence and next measurement |
| --- | --- |
| Read the device pixel ratio once per synchronous declaration pass. | Retained after baseline, candidate, and repeat. Large positioned edits improve about 8%, and structural batches improve 4–6%. No retained-memory or GC gain is claimed. |
| Compact declared-item snapshots. | Retained after four incremental comparisons: compact columns, known-prefix validation, direct indexing, and filtered row preparation. The final candidate repeats its 7.1 MiB saving and 36–38% shorter large positioned edits against v0.4.10. |
| Bulk paging with overlap, cancellation, and eviction. | The first installed-Firefox capture passes 120 cycles per case. Median page loads are 2 ms at a 480-item budget, 5 ms for 2,000 positioned items, and 16 ms for 10,000 stacked items. Matched comparisons and attribution remain open. |
| Sustained mixed-workload memory and natural GC. | The first capture records natural process samples and GC slices without diagnostic tabs or forced collection between cycles. Comparison with compact snapshots remains open. |

The prepared pager prototype consumes the temporary owner-count map after
whole-page eviction to form the exposed item array in page order. This removes
the intermediate flattened array and a second deduplication set without adding
a persistent index. It passes 396 focused unit tests and the paging regression
in Firefox, Chromium, and WebKit. Those are correctness checks, not performance
evidence: the prototype is not retained in production. Its source, hashes, and
validation metadata remain locally under `browser-artifacts/paging-owner-experiment/`.

Resume with a fresh v0.4.11 baseline, then one candidate and one repeat at 120
cycles per case. A longer control with profiling disabled can test whether
process growth persists beyond the diagnostic's recording interval. None of
these captures has completed yet. The existing 120-cycle baseline verifies
bounded active items and collection after disposal, but its natural process
samples do not establish a general memory plateau or a worst-pause improvement.

The ratio experiment's original patch and hashes are preserved locally under
`browser-artifacts/runtime-pixel-ratio-experiment/`. The retained change doesn't
cache the ratio between updates or skip host height and position callbacks.

## Prepared validation

The ratio candidate passes 5,643 unit tests, static checks, 190 portable
profiler checks, and the pixel-grid browser regression. Its added unit coverage
checks ratio changes between snapshots and individual edits. Performance
evidence comes from the separate matched Firefox captures.

The v0.4.11 snapshot changes pass 5,650 unit tests, static checks, all 190
portable profiler checks, both isolated consumer builds, seven runtime browser
regressions, and all seven gallery regressions. The final measured source
hashes match the release source.

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
