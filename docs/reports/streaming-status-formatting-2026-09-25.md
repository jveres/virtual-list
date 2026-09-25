# Reuse the streaming status number formatter

The streaming demo now reuses one `Intl.NumberFormat` for its status labels.
Previously, a status update called `Number.toLocaleString()` up to eight times,
including for unchanged history and mounted ranges. The change preserves
rounding and the browser's default locale. It does not change list geometry,
stream delivery, or renderer behavior.

## Investigation

The baseline is `4f51a38`. An installed-Firefox diagnostic capture ran first
on the LU28R55 external display. Its longest moving interval was 49.9 ms near
completion. Chrome's diagnostic capture recorded a 49.6 ms completion interval,
with most instrumented work in the final message-content update. A separate
400.9 ms interval included 16 message updates; the current attribution does
not establish the cause of that whole gap. Neither pause is claimed fixed.

Chrome also recorded 97.2 ms across 510 `syncMetrics` calls. Its native script
samples include `formatCount`. The initial formatter-reuse control recorded
49.3 ms across 521 calls. This is diagnostic evidence for a small reduction
in repeated formatting overhead, not a whole-page performance result.

## Conditions and reproduction

All captures use fresh profiles with DevTools closed, a warmed page, and the
tracked deterministic SSE workload: 48 sections, 160 history turns, 44,230
reply characters in 461 chunks, a 12-second stream, a 20-second capture, and
the long trail. The input hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

The display is LU28R55, 1920 × 1080 logical pixels, 2× scaling, and 60 Hz.
Outer windows are 1900 × 1049 at (1450, 31). Firefox's inner window is
1900 × 965; Chrome's is 1900 × 962. No CPU or network throttling is applied.
The installed builds are Firefox 156.0.1 and Chrome 153.0.8010.53.

Restore only `demos/streaming/streaming.ts` from `4f51a38` in a separate
baseline checkout. Keep the same profiler and locked dependencies. Run each
browser sequentially, comparing the baseline and candidate. The user's updated
limit is three trials per browser; do not repeat the six-run Firefox sequence
already completed in this investigation:

```sh
pnpm run profile:chat -- --browser=firefox --mode=timing \
  --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --mode=timing \
  --display=LU28R55 --refresh-hz=60
```

Use `--mode=diagnostic` for operation attribution. Diagnostic captures have
observer and wrapper overhead and are evaluated separately from timing runs.
Raw captures are temporary; compact summaries, commands, source hashes, and
reproduction patches are kept locally under ignored `browser-artifacts/`.

## Results

All eight timing captures completed the expected stream and passed validity
checks. Firefox used `B,C,C,B,B,C` before the user reduced the trial count.
Chrome completed one baseline and one candidate; queued repeats were cancelled
after the active capture finished and cleaned up.

| Timing metric | Baseline | Candidate |
| --- | ---: | ---: |
| Firefox moving p95, median (range), ms | 17.18 (17.08–17.24) | 17.14 (17.06–17.40) |
| Firefox content-thread CPU, median (range), ms | 3932 (3700–3954) | 3737 (3591–3823) |
| Firefox moving intervals over 25 ms, median (range) | 1 (1–2) | 2 (1–2) |
| Chrome moving p95, single trial, ms | 17.5 | 17.6 |
| Chrome main-thread task time, single trial, ms | 3704 | 3361 |
| Chrome maximum moving interval, single trial, ms | 199.9 | 83.2 |

Firefox's frame timing is effectively unchanged, and CPU ranges overlap.
The single Chrome timing pair cannot establish an overall performance or
worst-frame improvement. The retained change removes formatter setup without
adding scheduling, caches of message data, or alternate rendering behavior.
Its measured diagnostic `syncMetrics` cost per call fell from approximately
0.191 ms to 0.095 ms in the initial pair. That narrow observation is the
benefit claimed here; repeated confirmation remains unmeasured.

Local Firefox timing baseline IDs are `GfpvFU`, `vEymG4`, and `szUhWV`;
candidate IDs are `I9fstp`, `tFd1vy`, and `Enj64R`. Chrome timing IDs are
`yweWNB` and `Tz48E8`. These use the `<browser>-timing-` prefix under
`browser-artifacts/count-formatter/`. Initial diagnostics are
`firefox-diagnostic-TxsLGT`, `chrome-diagnostic-NA9XqA`, and
`chrome-diagnostic-RnDryD` under `browser-artifacts/chat-profile/`.

## Verification and cleanup

Static checks, all 1,044 unit tests, all 109 portable profiler checks, and the
production build pass. The profiler and paged-history browser regressions pass
in Firefox, Chromium, and WebKit, including send after paging and reload.
The first unit invocation could not bind its local relay test server in the
sandbox; the suite passed when rerun with loopback access.

Raw captures, compiler caches, and the temporary comparison driver were
removed. Compact results and reproduction metadata remain. No production
profiler code or dependency pin changed in this round.

## Limits

This round targets status formatting only. Completion rendering and occasional
long intervals remain separate investigation targets. These automatic-follow
captures do not test trackpad momentum, paging, or physical presentation.
