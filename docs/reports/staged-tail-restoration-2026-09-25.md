# Staged restoration of evicted chat history

The streaming demo prepares evicted history in bounded frame slices before
starting the native bottom animation. Previously, the button synchronously
rebuilt the entire tail window. This follow-up addresses the preparation
pause left open in the [native navigation report](native-smooth-navigation-2026-09-25.md).

## Implementation and interruption

The demo uses the runtime's existing `updateWindow` preparation queue. It keeps
the current history visible while preparing the replacement, shows the bottom
loader, and starts native smooth scrolling after the replacement commits.
The restored window retains the first-message anchor, leaving room for the
animation instead of immediately landing at the end.

Tree navigation and tail restoration share an abort controller. A newer top,
bottom, or tree command cancels the previous preparation. Keyboard input also
cancels through the runtime's existing input epoch. Old completion handlers
cannot reset a newer navigation's pager or prompt pin.

The archive continues receiving stream updates while the old pager is absent.
At commit, prepared rows receive any newer message objects before animation
starts. A browser regression caught the stopped-reply case during development:
updating the new pager was insufficient because it already held current data.
The final implementation updates the stale runtime rows directly.

This is a demo integration fix. It uses existing runtime and renderer APIs;
`markdown-viewer` remains pinned to released GitHub tag `v0.8.3`.

## Measurement method

The investigation starts with installed Firefox and repeats in installed
Safari and Chrome. Captures use the LU28R55 external display at 1920 × 1080
logical pixels, 2× scaling, and 60 Hz, with a 1900 × 1049 window at `(1450, 31)`.
Each uses an isolated browser session and closed DevTools.

The diagnostic button workload has 160 history turns, 48 reply sections,
44,230 reply characters, a 12-second stream, and a 20-second capture. Buttons
fire at 3, 6, 15, and 17.5 seconds. The idle bottom command restores evicted
history. Operation spans and the scheduling probe are enabled for every
comparison. These measurements include diagnostic overhead and do not measure
physical display presentation.

The source baseline is `4f6230366f868cc111209eaff180bbec7fdc6246`. The workload
hash is `b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
The browser builds are Firefox 156.0.1, Safari 27.0 (22625.1.29.11.27), and
Chrome 153.0.8010.53. Their content viewports are 1900 × 965, 1900 × 997
(detached Safari), and 1900 × 962 respectively. Comparisons are within each
browser and matching transport.

The largest frame intervals in the idle bottom command's 1.8-second window are:

| Browser | Synchronous baseline | Staged restoration |
| --- | ---: | ---: |
| Firefox | 100.02 ms | 33.76 / 33.90 ms |
| Safari, detached | 139 ms | 70 ms |
| Chrome | 66.70 ms | 33.30 / 33.30 ms |

All included captures reach all four requested edges and report zero uncovered
pixels at cached row-coverage publications. This does not prove paint coverage
between events. The small diagnostic sample supports the preparation change;
it does not establish a browser-wide speedup.

The baseline rebuilds 30 rows inside one bottom-button task. Firefox records
a 100.02 ms frame interval and a 103 ms callback gap. Staging spreads those
rows across frames; both Firefox repeats reduce the largest restoration
interval to about 34 ms, with callback gaps of 46–48 ms. The remaining largest
slice constructs and measures the single 48-section reply.

The comparable detached-Safari pair reduces the restoration interval from
139 ms to 70 ms. The earlier connected-Safari candidate is excluded: it used
a different transport and a 1900 × 945 content viewport. The comparison tool
rejects that pair. Each browser has three attempts in this round; Safari has
only one valid baseline/candidate pair.

Preparation now yields instead of blocking the click handler, so animation
starts later. Firefox's first native request moves from 90 ms after the click
to 261–297 ms; Safari's moves from 127 ms to 353 ms; Chrome's moves from 90 ms
to 203–205 ms. This is a responsiveness tradeoff, not a reduction in total
preparation latency. The loader and current
history remain available while the new window is prepared. Native animation
still starts only after measured rows are ready.

The remaining single-row preparation takes about 40–67 ms in instrumented staging
callbacks. Staging bounds the number of rows per slice, not the cost of an
individual render and measurement. The profiles also identify a later scroll
position read worth investigating separately. This round does not claim that
all synthetic frames fit within one refresh interval.

Local capture IDs are:

| Browser | Baseline | Candidates |
| --- | --- | --- |
| Firefox | `firefox-diagnostic-8wIXkT` | `firefox-diagnostic-4CzXRa`, `firefox-diagnostic-buhWD2` |
| Safari | `safari-diagnostic-gISV0f` | `safari-diagnostic-nSzdu3` |
| Chrome | `chrome-diagnostic-QKNiSH` | `chrome-diagnostic-DIuoHl`, `chrome-diagnostic-UtSAnc` |

Excluded transport control: `safari-diagnostic-RCD6zC`.

## Reproduce and verify

Run the same workload from the baseline and candidate revisions:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --safari-detached
pnpm run profile:chat -- --browser=chrome --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55
```

Each capture retains its exact source patch, hashes, replay command, and compact
summaries under ignored `browser-artifacts/chat-profile/`. Raw traces and
profiles are deleted after analysis. The synthetic input is generated by the
tracked profiler; no private transcript is needed.

The profiler also retains bounded Chrome stack attribution around individual
slow renderer events. `slowWindows` joins sampled leaf and ancestor costs to
at most eight non-overlapping events, rather than relying only on whole-capture
totals. It runs after capture, clips samples to each interval, and reports
sampling gaps and omitted frames. It does not add work to the scrolling page.
See the [profiling guide](../streaming-chat-profiling.md#read-the-report).

Verification passes `pnpm run check`, 1,052 unit tests, and 123 portable
profiling checks. The 21 chat-scrolling and chat-tree browser scripts pass
across their configured engines: 20 passed in the full run, and the corrected
tree-bottom script passed separately in Firefox, Chromium, and WebKit. That
script still expected the old serialized Markdown history; it now checks the
stopped reply through the structured-history API.

The new integration regression interrupts pending restoration with a keyboard
event and stops an evicted streaming reply during preparation. It verifies
that cancellation preserves the old window and that a subsequent restoration
shows the stopped state and reaches the bottom. The paged-history regression
also checks that a newer top command cancels pending restoration and that
restoration yields before rendering the evicted tail. Synthetic browser tests
verify behavior, not native-input or physical-presentation performance.
