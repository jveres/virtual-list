# Runtime boundary optimizations, October 1, 2026

Two changes survive the [complete runtime audit](runtime-complete-audit-2026-10-01.md):
bounded background reflow after width changes and a cheaper declarative pin
scan. Positioned-index reuse, filtered declared-row preparation, and a pager
copy change were prototyped and removed because the restored control did not
show enough benefit to justify retaining them.

## Measured results

The baseline column below is a fresh capture of the original runtime served
from revision `77e1d1839d536693be98ec050b73f37190938df5`. The candidate columns
are two fresh Firefox captures, not estimates or comparisons against another
layout mode. Conditions match the earlier audit.

| Measure | Original runtime control | Candidate 1 | Candidate 2 |
| --- | ---: | ---: | ---: |
| Largest resize-phase frame gap, 480 measured rows | 82.92 ms | 17.34 ms | 17.50 ms |
| Largest resize-phase frame gap, 1,000 measured rows | 166.00 ms | 17.22 ms | 17.46 ms |
| Resize phases with an interval above 25 ms | 2 | 0 | 0 |
| Time to finish all resize work, 480 rows | 243 ms | Not recorded | 399 ms |
| Time to finish all resize work, 1,000 rows | 324 ms | Not recorded | 683 ms |
| Total API time for 60 pin-bearing edits, 10,000 items | 108 ms | 22 ms | 43 ms |
| Median / p95 for those edits | 2 / 2 ms | <1 / 1 ms | 1 / 2 ms |

The earlier unchanged-runtime captures had resize gaps of 83–100 ms and
167 ms, consistent with the restored control. The pin predicate still runs
600,000 times in each 10,000-item case. The saving comes from reaching each
item directly rather than looking up its key and index on every predicate
call. Timing uses the page's approximately 1 ms clock resolution, so totals
and repeated results matter more than sub-millisecond claims.

The resize change improves responsiveness by distributing work. It makes
complete background convergence slower: about 0.4/0.68 seconds in this fixture,
including the initial quiet-width wait. Scroll range and detached-row geometry
can therefore retain old-width measurements longer. Commands, window commits,
and settle commits retain the existing synchronous drain when they require
exact geometry. One exceptionally expensive row can still exceed a frame
budget; the batch limit is a row count, not a hard time guarantee.

The whole-recording reflow totals are 463.74 ms for the control and
466.74/475.82 ms for the candidates. The smaller resize tasks do not establish
less total layout work. Those totals also include construction and API cases.
Regular animation-frame callbacks do not prove smooth physical presentation.

## Implementation

In [virtual-list.ts](../../src/virtual-list.ts), the quiet-width timer now
starts a batch of at most 32 detached rows. Further batches use animation
frames, check that the list is idle, and commit through the existing anchor
and follow machinery. Mounted rows remain urgent. A new width cancels the
scheduled frame and restarts the quiet wait. Full drains and disposal cancel
outstanding batch frames. A hidden document finishes through the timer in one
pass, since animation frames can stop there. No alternate measurement surface
or estimated height is introduced.

`selectPin` now scans the desired item array backward, substituting the edited
item while staging `updateItem`. The matching array index maps to the desired
key order with the leading slot offset. The predicate is still reevaluated
in the same order on every submission, preserving stateful predicates,
last-match behavior, slot exclusion, and pending snapshots. There is no pin
cache and no new public option.

## Rejected prototypes

These measurements are totals for 60 API calls at 10,000 retained items.

| Prototype | Original runtime control | Candidate 1 | Candidate 2 | Decision |
| --- | ---: | ---: | ---: | --- |
| Reuse an identical positioned index and filter preparation to retained declared elements | 248 ms | 213 ms | 233 ms | Remove. The repeat saves about 0.25 ms per call; median/p95 remain 4/5 ms versus 4/5 ms in the control. |
| Filter ordinary declared-row preparation during edge-slot changes | 403 ms | 373 ms | 374 ms | Remove. About 0.5 ms per infrequent loader change is insufficient for the additional preparation path. Median is 7 ms in the control and 6 ms in both candidates. |
| Copy the pager's exposed array with spread and replace one index | 55 ms | 56 ms | 55 ms, original code restored | Remove. No demonstrated gain; no ownership-index redesign was added. |

The positioned and slot results share the preparation prototype, so this
comparison does not isolate the benefit of each individual implementation
detail. All placement, key, and height callbacks remained evaluated. A
constant-time positioned update would need a different host contract; this
change does not add one. The larger apparent gains against the earlier audit
became smaller against the fresh original-runtime control, which is why these
prototypes were not retained.

Candidate 1 includes every prototype; candidate 2 already restores the pager.
After the comparison, the positioned index and preparation changes were also
removed. Those discarded paths are not invoked inside the measured resize
drain or single-item pin-edit phases. The visible drain and pin-edit paths
retain the candidate 2 implementation; a hidden-document timer fallback is
added during final correctness checks. No whole-application
CPU saving is claimed for the final subset, and no extra native capture was
added after the three valid trials.

## Workload and reproduction

The [fixture](../../scripts/firefox-profile/fixtures/runtime-boundaries.js)
is the audit's deterministic workload: 10 warmup edits followed by 60 timed
edits at 1,000 and 10,000 declared 80-pixel rows, 400-pixel overscan, and a
visible middle-row target. Resize cases retain 480/1,000 identical rows with
eight wrapping paragraphs each. Width changes from 1,100 to 650 CSS pixels;
all final row heights and offsets are verified. Candidate 2 and the restored
control add a cached-state completion timestamp to the same workload.

Environment: installed Firefox 157.0, build `20260924084938`, macOS 27.0,
fresh temporary profiles, closed DevTools; LU28R55, 1,920×1,080 logical pixels,
2× scaling, 60 Hz. Browser outer geometry is 1,900×1,049 at (1,450, 31),
content 1,900×964. The viewport is 924 pixels tall. Captures use automatic
API navigation and resize anchoring, not wheel or trackpad momentum.

```sh
# Candidate server and capture; use the recorded candidate patch.
pnpm exec vite --host 127.0.0.1 --port 4194 --strictPort
pnpm run profile:firefox -- --display=LU28R55 --refresh-hz=60 --live --layout=none --url=http://127.0.0.1:4194/scripts/firefox-profile/fixtures/runtime-boundaries.html --output=browser-artifacts/runtime-boundaries-implementation --idle-seconds=30 --warmup-ms=2000

# Original-runtime control; the fixture and dependencies stay the same.
node scripts/firefox-profile/runtime-revision-server.mjs 77e1d1839d536693be98ec050b73f37190938df5 4195
pnpm run profile:firefox -- --display=LU28R55 --refresh-hz=60 --live --layout=none '--url=http://127.0.0.1:4195/scripts/firefox-profile/fixtures/runtime-boundaries.html?runtime-revision=77e1d1839d536693be98ec050b73f37190938df5' --output=browser-artifacts/runtime-boundaries-implementation --idle-seconds=30 --warmup-ms=2000
```

Local-only run IDs under ignored `browser-artifacts/runtime-boundaries-implementation/`:
`run-qvFiJd` (candidate 1), `run-CMBhR9` (candidate 2), and `run-IkuvP6`
(original control). The control's `served-runtime.json` records the revision
server override: its captured working-tree patch contains candidate code,
but the server serves every `src/` module from the original revision.
Compact summaries, source patches and hashes, commands, browser build, and
display metadata remain locally. Raw captures and temporary profiles are
removed after analysis.

Both candidates record 39 scroll events and 39 scroll ends; the control
records 17 and 19. Batching adds intermediate anchor adjustments, so these
counts are expected to differ. All cases verify final geometry and edits.

Three earlier launches failed before capture because page readiness preceded
Firefox's accessible window. They are invalid evidence. The runner now waits
up to ten seconds for that window before placing it, within its existing
15-second placement timeout. Three subsequent captures complete successfully.

## Verification

The final patch adds unit coverage for reading-anchor preservation between
batches, restarting the width wait, exact command takeover, cancellation on
disposal, completion when hidden animation frames stop, and stateful pin
selection with start/end slots. The width browser
regression now checks painted row fit and reading position on every background
drain frame, in addition to comparing final geometry with a fresh list.

Run `pnpm run check`, `pnpm test`, `pnpm run test:firefox-profile`, and the
runtime regressions for `width-two-tier`, `runtime-boundaries`,
`native-anchoring`, and `pixel-ratio-grid`.

All checks pass: 5,631 unit tests and 185 portable profiler checks. The width,
boundary-fixture, and native-anchoring regressions pass in Firefox, Chromium,
and WebKit; the pixel-ratio regression passes in Chromium, whose CDP override
supports its live scale-change test. The checker reports only the existing two
diagnostic CSS warnings, and unit tests retain existing dependency source-map
warnings. Task-owned browsers, helpers, and servers are closed; the existing
development server is preserved.
