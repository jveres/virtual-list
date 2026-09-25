# Follow-up streaming performance review

After releasing `markdown-viewer v0.8.2` and pinning it in `a145fcd`, two more
measured candidates were tested and rejected. Neither demonstrated a net
performance improvement in the covered complex-stream workload. The final
application retains the released renderer and its original stream delivery.

## Conditions

The immediately preceding `v0.8.2` captures serve as baselines. Their built
JavaScript and CSS were verified byte-for-byte against the released GitHub tag.
This avoids redundant baseline runs. Each candidate uses the same workload,
browser builds, window geometry, and external display described in the
[finalization report](streaming-finalization-2026-09-25.md): Firefox 156.0.1,
Chrome 153.0.8010.53, LU28R55 at 1920 × 1080 logical pixels, 2× scaling, 60 Hz,
48 sections, 160 history turns, and a 12-second stream. Captures use fresh
profiles, closed DevTools, and the long trail.

Diagnostic operation times and sample counts include instrumentation overhead.
Timing-mode totals are compared separately. The small samples are sufficient
to reject adding complexity without a demonstrated gain; they do not establish
that either technique must regress every workload.

## Rejected source-range cache

The trail's `readSourceSegments` repeatedly decodes source-map attributes.
The prototype stored each element's current attribute, decoded numeric ranges,
and maximum end offset in a `WeakMap`. Attribute changes invalidated the entry;
text nodes and exclusions were read fresh. Focused tests passed for mapping
changes, replaced text nodes, hidden content, malformed data, and removal.

| Measure | Released renderer | Cache candidate |
| --- | ---: | ---: |
| Chrome sampled wall time in `readSourceSegments` | 284.1 / 276.2 ms | 257.7 ms |
| Chrome main-thread task time | 3320 / 3290 ms | 3486 ms |
| Firefox diagnostic content-thread CPU | 3960 ms | 4497 ms |
| Firefox samples attributed to `readSourceSegments` | 288 | 345 |

The modest Chrome attribution reduction did not translate into lower task time.
Firefox also failed to show a gain. The cache was removed; no additional
renderer release was created for it. Candidate run IDs are Firefox diagnostic
`pkQtfN` and Chrome timing `JZVnS7`.

## Rejected network-read coalescing

The stream parser prototype combined adjacent text deltas within one network
read. It flushed at tools and other non-text chunks, completion, errors, and
before awaiting another read. It introduced no timer or frame delay. Focused
tests passed for ordering, tool boundaries, partial text before an error,
immediate delivery, and early cancellation.

Firefox message-content updates fell from 467 to 458. The largest observed
same-frame `updateItem` group fell from seven calls to three. However, its
diagnostic content-thread CPU rose from 3960 to 4165 ms. Chrome timing task
time was 3540 ms versus the baseline's 3290–3320 ms; its 17.8 ms maximum moving
interval did not improve on the best existing baseline. The candidate removed
work but demonstrated no net performance benefit, so the code and its new
behavior-specific tests were removed. Candidate IDs are Firefox diagnostic
`54b8hk` and Chrome timing `fKD0lO`.

Baselines for both experiments are Firefox diagnostic `07VLQm` and Chrome
timing `V1secn` / `dqP0in`. Run names have their browser/mode prefixes under
ignored `browser-artifacts/chat-profile/`.

## Final native scrollback check

The released implementation completed the complex stream while native macOS
input scrolled Firefox through older history. Run `firefox-diagnostic-KC5J6I`
passed validity with 897 wheel events, 894 scroll events, 17 scroll ends, and
894 moving intervals. Loaded history expanded from 133–160/160 to
109–162/162. Moving p95 was 17.16 ms and maximum was 17.62 ms; the measurement
records callbacks and movement, not physical presentation or trackpad momentum.

In that capture, maximum instrumented row construction was 6 ms, live content
update was 4 ms, and viewport-state reads were 5 ms. None provides evidence for
another high-cost scroll-path patch. Required geometry reads, current text
rendering, and trail painting remain; their existence alone does not establish
redundant work.

A final Safari diagnostic capture, `safari-diagnostic-qrlAHw`, completed the
same follow workload. Moving p95 was 20 ms, maximum was 44 ms, and the largest
instrumented content update was 6 ms. An 86 ms non-moving interval near
14 seconds repeats the earlier observation. Only about 1 ms of instrumented
application work overlaps it. The common recorder does not attribute the
remaining time to native Safari rendering, renderer internals, or the Inspector
transport. It remains unresolved; no speculative scheduling or rendering patch
was applied to it.

## Reproduction and stopping point

Use the finalization report's commands and pinned versions. Add
`--scenario=scrollback --mode=diagnostic` for the native scrollback check.
Compact summaries and reproduction patches remain locally. Rejected candidate
patches are under ignored `browser-artifacts/rejected-streaming-candidates/`:
apply the range patch to renderer `v0.8.2`, or the coalescing patch to consumer
`a145fcd`, then rebuild and rerun the same workload. Raw captures are removed.

No further safe change with a demonstrated net gain was found in these follow
and scrollback workloads. This is a scoped stopping point, not proof that every
browser, transcript, refresh rate, or future workload is fully optimized.

Both rejected prototypes were reverted to the already-verified release. Only
this report and its index entry changed afterward. Raw captures, generated
screenshots, compiler/Vite caches, temporary packages, and the temporary
upstream checkout were removed. Compact summaries and replay patches remain.
The final process audit found only pre-existing user browsers and development
servers; profiling browsers, automation drivers, helpers, and test servers
were closed.
