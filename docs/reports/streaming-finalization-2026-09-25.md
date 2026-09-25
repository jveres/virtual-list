# Reuse processed blocks when streaming ends

The renderer discarded its processed blocks on the transition from streaming
to settled, then post-processed and morphed the entire reply. The upstream fix
keeps the current block state for settled renders and passes its fragments to
the existing optimized morph. The parser still resolves the full final source;
only blocks with exactly unchanged parser output reuse processed HTML.

This preserves updates to references, earlier blocks, and the final text. Hooks
that require whole-document processing retain the existing fallback. Cursor
removal, height preservation, and final callbacks keep their existing order.
The implementation belongs to `markdown-viewer`, not the demo.

The fix is released upstream in
[markdown-viewer v0.8.2](https://github.com/jveres/markdown-viewer/tree/v0.8.2),
commit `6bcb227`. This repository pins that GitHub tag.

## Measurement

The application baseline is `a3db034` with `markdown-viewer v0.8.1`.
Installed Firefox was captured first on the LU28R55 external display at
1920 × 1080 logical resolution, 2× scaling, and 60 Hz. All valid captures use
fresh profiles or isolated Safari automation, closed DevTools, a warmed page,
and the same tracked workload: 48 sections, 160 history turns, 44,230 response
characters in 461 chunks, a 12-second stream, a 20-second capture, and the long
trail. No CPU or network throttling is applied. The input hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

Firefox is 156.0.1 and Chrome is 153.0.8010.53. Their outer windows are
1900 × 1049 at (1450, 31); inner sizes are 1900 × 965 and 1900 × 962,
respectively, at DPR 2. Safari retains its Inspector-backed MCP transport in
both variants. The source-owned candidate was built and temporarily installed
from a local tarball for measurement; the final dependency uses its upstream
GitHub release tag.

The first Firefox launch could not activate its window and is excluded. Its
retry and candidate both passed capture validity. Firefox diagnostics measured
30 ms of message-content updates within the baseline completion interval and
10 ms with the candidate. The interval fell from 50.02 ms to 34.06 ms. These
figures include diagnostic overhead and do not establish a timing-mode CPU gain.

Chrome used three timing trials: one baseline followed by two candidates.
All completed the expected stream and passed validity checks.

| Chrome timing metric | Baseline | Candidate 1 | Candidate 2 |
| --- | ---: | ---: | ---: |
| Completion microtask, ms | 81.41 | 23.93 | 24.60 |
| Maximum moving interval, ms | 66.4 | 17.8 | 33.3 |
| Moving p95, ms | 17.5 | 17.6 | 17.6 |
| Moving intervals over 25 ms | 1 | 0 | 1 |
| Main-thread task time, ms | 3356 | 3320 | 3290 |

The result supports reduced completion work. Sustained frame timing remains
similar. One candidate still crosses a refresh interval at completion, so the
change does not establish jitter-free physical presentation or eliminate all
long frames. The small sample does not establish a broad CPU improvement.

Safari 27.0 (22625.1.29.11.27), with a 1900 × 945 inner window, completed
one timing capture per variant. Moving p95 was 20 ms before and 21 ms after;
maximum moving intervals were 48 ms and 28 ms, and moving intervals over
25 ms were 13 and 8. Both also recorded an idle, non-moving interval around
14 seconds of 83–86 ms. That idle stall remains; the pair does not establish
a Safari CPU or physical-presentation improvement.

Local Firefox diagnostic IDs are `sdHBul` and `07VLQm`. Chrome timing IDs are
`1LWbQk`, `V1secn`, and `dqP0in`, under ignored
`browser-artifacts/chat-profile/` with their browser/mode prefixes. Failed
Firefox `5ZMd4w` is not performance evidence.
Safari timing IDs are `jcCNjp` and `53LTpT`.

## Reproduce

Use the profiler in this report's commit and the locked dependencies. For a
baseline checkout, restore `package.json`, `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` from `a3db034`,
then run `pnpm install --frozen-lockfile`. Compare no more than three trials per
browser on the same display:

```sh
pnpm run profile:chat -- --browser=firefox --mode=diagnostic \
  --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --mode=timing \
  --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=safari --mode=timing \
  --display=LU28R55 --refresh-hz=60
```

Raw captures are temporary analysis inputs. Compact summaries, source hashes,
commands, and reproduction metadata remain locally. These follow-mode captures
do not test trackpad momentum, paging, or physical presentation.

## Verification

The upstream static checks, 1,151 unit tests, package build, and full cursor
browser suite pass. Tests cover skipped unchanged blocks, changed references
and final text, output parity, cursor lifecycle and spacing, 551 trail-source
cut points in each engine, final glyphs, formulas, terminal text, and cleanup.
The temporary-checkout browser suite initially encountered Vite's filesystem
restriction on symlinked dependencies; installing isolated dependencies fixed
the test setup before the passing run.

The consumer passes static checks, 1,044 unit tests, 109 profiler checks, and
all six streaming regression scripts plus the profiler regression. Browser
checks cover Firefox, Chromium, and WebKit. The release build is compared with
the measured candidate before accepting the GitHub pin. No local dependency
patch is retained.
