# Rejected native scroll listener-order control

Moving the native glide observer to capture phase did not produce a repeatable
performance gain. The prototype and its dedicated test were removed. The
shipped implementation keeps the original event order.

## Hypothesis and method

A Chrome stack attributed a slow task to reading `scrollTop` in the native
glide observer. The runtime's bubble-phase listener can change rows before
that read. The prototype registered the observer with `capture: true`, filtered
out nested-element events with `event.target`, and used the same capture flag
when removing the listener. This tested whether reading before the runtime's
handler avoided a flush.

Installed Firefox was measured first, followed by installed Safari and Chrome.
Each browser had three trials: its final staged-restoration capture as baseline
and two prototype captures. All used diagnostic probe 2 with scheduling enabled,
the 160-turn/48-section button workload, a 12-second stream, and a 20-second
capture. The LU28R55 display was 1920 × 1080 logical pixels, 2×, 60 Hz, with a
1900 × 1049 window at `(1450, 31)`. Safari used the detached MCP transport in all
three runs. Browser versions and content viewports match the
[staged-restoration report](staged-tail-restoration-2026-09-25.md).

## Results

| Metric | Baseline | Candidate 1 | Candidate 2 |
| --- | ---: | ---: | ---: |
| Firefox GeckoMain sampled CPU | 3,937.505 ms | 3,601.037 ms | 3,950.217 ms |
| Firefox styles | 698.862 ms | 410.484 ms | 670.684 ms |
| Firefox flush markers | 1,051.021 ms | 755.122 ms | 1,034.902 ms |
| Chrome main-thread task duration | 3,241.772 ms | 3,730.884 ms | 3,676.123 ms |
| Chrome style duration | 502.003 ms | 493.451 ms | 488.121 ms |
| Chrome layout duration | 362.846 ms | 361.271 ms | 353.643 ms |
| Safari idle bottom largest frame interval | 70 ms | 69 ms | about 70 ms |
| Safari largest moving interval | 59 ms | 54 ms | 54 ms |

Firefox's first apparent gain did not repeat. Chrome still had a roughly 34 ms
late bottom-navigation task; changing which stack received the cost did not
remove it. Safari's results were effectively unchanged. Native markers and
sampled CPU have different meanings and must not be summed.

All captures reached all four requested edges and reported zero gaps at cached
coverage publications. These observations do not measure physical presentation.
The control does not justify changing listener ordering.

## Reproduction

The baseline implementation is consumer commit `a9e16ae` with the probe-2
instrumentation from that commit. Register the native observer in
`src/native-glide.ts` with `capture: true`, ignore events whose target is not the
viewport, and remove the listener with the matching capture flag to reconstruct
the rejected control. Run the commands in the staged-restoration report without
changing the workload, transport, or display geometry.

| Browser | Baseline | Candidates |
| --- | --- | --- |
| Firefox | `firefox-diagnostic-buhWD2` | `firefox-diagnostic-1RrMqn`, `firefox-diagnostic-W0jQyc` |
| Safari | `safari-diagnostic-nSzdu3` | `safari-diagnostic-DUC8OV`, `safari-diagnostic-Dv3LpL` |
| Chrome | `chrome-diagnostic-UtSAnc` | `chrome-diagnostic-MhH6vx`, `chrome-diagnostic-QUnB4p` |

Compact local summaries and exact source patches remain reproducible. Raw
profiles were discarded after analysis. The original Chrome baseline's
experimental slow-window sample attribution predates overlap handling and is
marked invalid locally for quantitative sample-duration comparisons. The table
uses native event durations, which are unaffected by that analyzer correction.
