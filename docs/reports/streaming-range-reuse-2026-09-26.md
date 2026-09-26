# Streaming trail range reuse

The remaining Chrome streaming spikes included native DOM insertions and
removals, even when an update changed only a few dozen nodes. The renderer
created a new live `Range` for each measured text fragment and display formula.
Reusing one range per trail removes that source of allocation and mutation
overhead. The large reply's initial layout remains a separate cost.

## Diagnosis and implementation

The Chrome analyzer previously retained sampled stacks only for renderer
events lasting at least 32 ms. Its cutoff is now 16 ms, still bounded to eight
non-overlapping windows. This exposes short stalls near a 60 Hz frame budget
without adding work to the measured page. A portable regression covers the
cutoff; existing checks cover clipping, nested events, recursion, and bounded
output.

The new evidence shows late trail-rectangle removal calls taking about
19–21 ms, and a content update reaching 23.8 ms. Whole-document DOM rewrites
were not responsible for those updates. Chromium's
[document mutation implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/dom/document.cc)
iterates attached ranges during node removal. Together with the allocation
pattern and the candidate comparison, this supports range maintenance as the
cause. The source link is explanatory; it is not an assertion that the installed
Chrome binary uses that exact revision.

The fix is released in [`markdown-viewer v0.8.5`](https://github.com/jveres/markdown-viewer/tree/v0.8.5),
commit `7410216a01b355b1ea5a78d71a94485a6142a3c8`. This repository pins that
GitHub tag in its manifest and lockfile; the build allowlist names only the
new dependency commit. One range serves text and display-math
geometry reads across paints. Its boundaries reset to the document after the
reads and during cleanup, so it does not retain a measured text node. It does
not change selection, trail age, rectangle limits, or source ownership.

The regression measures several text and formula updates: the old code creates
90 ranges and fails; the fixed code creates one and passes. Existing browser
regressions check the rendered geometry and trail lifecycle.

## Conditions and results

The investigation starts with installed Firefox. All native captures use the
LU28R55 at 1920 × 1080 logical pixels, 2× scaling, and 60 Hz. Windows measure
1900 × 1049 at `(1450, 31)`. Browser builds and inner viewports are Firefox
156.0.1 at 1900 × 965, Chrome 153.0.8010.53 at 1900 × 962, and Safari 27.0
(22625.1.29.11.27) at 1900 × 997. Safari disconnects its automation driver before
measurement. Each capture uses an isolated session with DevTools closed.

The diagnostic button workload streams 48 sections and 44,230 characters over
12 seconds, with 160 history turns and a 20-second capture. Its hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
The operation and scheduling probes are enabled. Source baseline:
`5576ad0b43d352b1ad406bec442d492114dd3387`, with renderer `v0.8.4`.

The layout investigation used at most three trials per browser. The subsequent
range comparison reuses its matching baseline and adds a source candidate and
a repeat of the published release. These are separate implementation controls,
not extra trials added to increase sample size.

The Chrome comparison isolates the reproduced mutation stalls:

| Metric | Baseline | Source candidate | Published tag |
| --- | ---: | ---: | ---: |
| Largest content update | 23.8 ms | 7.6 ms | 8.5 ms |
| Recorded insert/remove time | 1,207.2 ms | 53.8 ms | 54.8 ms |
| Recorded insert/remove calls | 6,505 | 6,524 | 6,630 |
| Main-thread task time | 3,750 ms | 3,134 ms | 3,256 ms |
| Largest moving frame interval | 50.0 ms | 33.5 ms | 33.3 ms |

Insert/remove time covers instrumented `insertBefore`, `remove`, and
`removeChild` calls. These are wall-time measurements, not CPU utilization.
The initial Chrome layout-control baseline had a smaller 10.7 ms maximum
content update; the later unchanged baseline reproduced 23.8 ms spikes.
The allocation regression and two fixed captures support the fix despite
that timing variability. The small diagnostic sample does not establish a
general browser-wide speedup.

All three browsers report all four button destinations, with zero uncovered
pixels at cached coverage publications. The later
[completion-metric correction](staged-row-layout-2026-09-26.md#corrected-navigation-metric)
shows why the old bottom count alone cannot prove restored-tail arrival.
Their moving-frame results are:

| Browser | Moving p95: baseline → fixed trials | Maximum: baseline → fixed trials |
| --- | --- | --- |
| Firefox | 17.12 → 17.14 / 17.14 ms | 33.92 → 50.14 / 49.20 ms |
| Chrome | 17.50 → 17.50 / 17.50 ms | 50.00 → 33.50 / 33.30 ms |
| Safari, detached | 21 → 21 / 19 ms | 62 → 56 / 57 ms |

Firefox's largest intervals occur during large-row restoration and are worse
in both fixed captures. Its staging spans are 43 → 47 / 45 ms; this round
does not demonstrate a Firefox restoration improvement. Chrome staging is
35.8 → 38.2 / 36.9 ms, and Safari is 53 → 52 / 52 ms. The range correction
does not resolve that separate render-and-layout cost.

Capture IDs for the range comparison are:

| Browser | Baseline | Source candidate | Published tag |
| --- | --- | --- | --- |
| Firefox | `firefox-diagnostic-aVNTyO` | `firefox-diagnostic-GEu0Oh` | `firefox-diagnostic-KLh8JV` |
| Chrome | `chrome-diagnostic-eQlX33` | `chrome-diagnostic-AjfELd` | `chrome-diagnostic-T8f0Xj` |
| Safari | `safari-diagnostic-GRcNgV` | `safari-diagnostic-8yRf7T` | `safari-diagnostic-gBLiFV` |

The comparison tool accepts the pairs: browser build, workload, probe,
transport, display geometry, and refresh rate match within each browser.

## Rejected layout controls and remaining costs

Normal block layout for assistant messages did not reduce the large reply's
preparation time: Firefox stayed at 43 ms and Safari at 53–54 ms. Chrome still
showed late content updates above 22 ms. This change was reverted.

Using opacity instead of inherited visibility for parked rows passed the
hidden-row browser checks. Firefox's remount span fell, but total viewport-read
work did not improve, and Safari still reached 66 ms. That change was also
reverted. Neither control establishes a jitter fix.

The rejected block-layout captures are `firefox-diagnostic-gsCltd`,
`chrome-diagnostic-6QZ9Xz`, and `safari-diagnostic-A2jJ1f`. The opacity captures
are `firefox-diagnostic-f30Gql` and `safari-diagnostic-zRwclL`. Chrome instead
used its third layout-round trial to repeat the original code with the richer
post-capture analyzer (`chrome-diagnostic-eQlX33`); its initial baseline was
`chrome-diagnostic-eJWqQd`.

The range fix addresses unnecessary renderer work. It does not split the
creation and first layout of one very large row, nor remove Safari's separate
restoration gaps. Regular animation-frame callbacks and cached coverage do not
prove smooth physical presentation. No iPhone/iPad momentum capture was part
of this round.

## Verification

The upstream release passes its type/lint checks, 1,154 unit/component tests,
package build/boundary checks, and all 16 cursor/trail browser scripts across
their configured Firefox, Chromium, and WebKit cases.

The consumer passes `pnpm run check`, all 1,065 unit tests, and 126 portable
profiling checks. Loopback-server tests initially encountered sandbox bind
errors and passed when rerun with loopback access. Eight consumer browser
regressions pass: Markdown streaming, paged streaming, standalone streaming,
streaming height, trail geometry, shared-trail pixels, answer-follow limits,
and footer behavior. The installed trail module has the same SHA-256 as the
tested upstream build:
`aaf0244e7bb7d547b788ef4e0daf2d31bc1b953c0f01a4dde8db3f1aeeb1b2b9`.

## Reproduction and retained data

Use the same commands at the baseline and fixed revisions:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --mode=diagnostic --scheduler --safari-detached \
  --display=LU28R55 --refresh-hz=60
```

Compact summaries, source patches and hashes, exact commands, workload metadata,
browser builds, and display geometry remain under ignored
`browser-artifacts/chat-profile/`. Temporary dependency candidates include an
`upstream.patch` and build instructions. Raw profiles and traces are deleted
after analysis. No private transcript or remote inference is required.
