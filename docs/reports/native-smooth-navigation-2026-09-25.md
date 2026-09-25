# Native smooth navigation

The streaming demo's top and bottom buttons now use the browser's smooth
animation. After testing the regular demo in Firefox, Safari, and Chrome, the
user reports smooth scrolling with no lag. The runtime verifies arrival before
completing a command, including when `scrollend` is missing. Automatic stream
following and commands with an explicit duration retain the custom glide.

This follows the [Safari button investigation](safari-trail-disposal-2026-09-25.md#programmatic-button-follow-up).
That investigation reproduced idle button jitter on the external display and
found synchronous compositing work beneath repeated `scrollTop` writes. Its
idle custom glides did not restart their easing or reject their writes.

## Change and completion contract

Native scrolling runs inside the existing command ownership and settle rules.
It calls `scrollTo({ top, behavior: "smooth" })` once per destination leg.
The browser chooses the animation timing. A growing destination starts a new
leg after the current leg finishes, without restarting native easing each frame.

The completion and cancellation rules are:

- Confirm the current position is within one pixel of the live destination
  before treating `scrollend` as successful arrival.
- Confirm arrival after 120 ms without a scroll callback when the event is
  missing. No-op commands complete asynchronously without waiting for an event.
- Resolve an unfinished command as `false` after two seconds without movement.
  A timeout never counts as successful arrival.
- Stop native motion when a command is superseded, disposed, or interrupted
  by real input. Scroll keys cancel too; typing in editable controls does not.
- Keep gesture-settle fallbacks from declaring the animation finished while
  it still owns scrolling.

One Safari control initially stayed still because takeover rebuilt the
scrolling layer immediately after cancelling an owned glide. Cancellation
already stops that motion. Skipping the redundant overflow reset allowed all
four requested edges to be reached in the subsequent valid capture. Native
gesture interruption retains its separate takeover path.

The [API contract](../core-contract.md) and [README](../../README.md) document
the native default and explicit-duration behavior. The final demo keeps the
existing history restoration and send behavior that the user tested.

## Measurement conditions

The investigation began with installed Firefox, with an explicit Safari-only
exception for native WebKit stack attribution. Final captures use isolated
browser sessions, closed DevTools, and the LU28R55 display: 1920 × 1080 logical
pixels, 2× scaling, and 60 Hz. Windows are 1900 × 1049 at `(1450, 31)`.
Firefox's content viewport is 1900 × 965. The detached Safari timing capture
has a 1900 × 997 content viewport; its connected screenshot diagnostic uses
1900 × 945. Those two Safari modes are not paired timing evidence.

The synthetic workload has 160 history turns, 48 complex reply sections,
44,230 reply characters, 461 text chunks, and a 12-second stream. Each capture
lasts 20 seconds. Top/bottom presses occur at 3, 6, 15, and 17.5 seconds.
The workload hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

Final installed-browser results are:

| Browser | Moving rAF interval p95 | Largest moving interval | Requested edges reached |
| --- | ---: | ---: | ---: |
| Firefox 156.0.1, build 20260921121718 | 17.24 ms | 100.16 ms | 4/4 |
| Safari 27.0, build 22625.1.29.11.27 | 20 ms | 136 ms | 4/4 |
| Chrome 153.0.8010.53 | 17.50 ms | 33.70 ms | 4/4 |

The comparable Firefox custom-button baseline has a moving p95 of 17.36 ms
and a maximum of 99 ms. The comparison tool accepts the pair's workload,
instrumentation, browser, and display settings. This single pair indicates
similar callback cadence, not a general performance improvement. Its idle top
arrival changes from 1,242 ms to 870 ms; native timing is browser-controlled.

The largest Firefox and Safari intervals coincide with synchronous restoration
of an evicted history window before the bottom animation. The earlier
diagnostic measured that work separately at 143 ms. Native scrolling does not
remove that preparation cost. The user's smoothness confirmation concerns the
regular demo after testing idle navigation, streaming, and loaded history; it
does not establish that every synthetic interval is below one display period.

Local timing IDs are `firefox-timing-2dw832` (custom-button baseline),
`firefox-timing-uEtQAh`, `safari-timing-GJYwJn`, and `chrome-timing-1H7n5p`.
A failed Firefox focus attempt (`firefox-timing-sGa9aC`) is excluded. No
comparison round exceeds three trials per browser.

## Blank-content diagnostics

The profiler now records mounted-row coverage from cached geometry whenever
the runtime publishes. It also records navigation arrivals, scroll requests
and their callers, custom-glide restarts, and the intervals around each button
press. None of these probes adds DOM layout reads to the animation sampler.

A separate connected Safari diagnostic (`safari-native-visible-lMNFNY`) reached
all four edges and found zero uncovered pixels across 1,272 row-coverage
publications. Six browser snapshots had horizontal edge densities of
0.070–0.084. Inspected snapshots contained the expected text, tables, code,
and math. This does not establish paint coverage between observations:
screenshots can force painting, and compositor movement can occur between
main-thread callbacks. The snapshot overhead makes this capture unsuitable
for a timing comparison. No placeholders are added to the validated fix.

ScreenCaptureKit was also considered for physical presentation diagnostics,
but macOS denied screen-recording access before capture. The unused prototype
is removed. The reusable browser-snapshot method records its limitations and
deletes raw images after analysis.

## Reproduce and verify

The consumer source begins at `bc56865a6340ce21f5c3d98732ea139aa6c1e3c7`.
Compact capture metadata records the source patch, hashes, browser build,
geometry, and command. The renderer fix is published as
[`markdown-viewer` v0.8.3](https://github.com/jveres/markdown-viewer/tree/v0.8.3),
commit `3708f020f2417c194da3d928bb0800a49b39d6b9`, and the consumer manifest
and lockfile pin that GitHub tag. Exploratory local renderer variants retain
small upstream source patches and build recipes instead of package archives.

Run the final timing workload with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons --display=LU28R55
pnpm run profile:chat -- --browser=safari --scenario=buttons --display=LU28R55 \
  --safari-detached
pnpm run profile:chat -- --browser=chrome --scenario=buttons --display=LU28R55
```

Use the [profiling guide](../streaming-chat-profiling.md#check-programmatic-navigation-and-rendered-content)
for diagnostic coverage, Safari snapshots, and native stack sampling. Keep
diagnostic and timing runs separate. Raw profiles and synthetic screenshots
are temporary analysis inputs; compact summaries and replay metadata remain.

Verification includes `pnpm run check`, 1,052 unit tests, 120 portable profiling
checks, and the native navigation, chat scrolling, and chat profiler browser
regressions. Real-engine tests cover missing events, no-op commands,
supersession, keyboard cancellation, disposal, and history paging. These
correctness tests complement the installed-browser captures and the user's
manual confirmation; they do not simulate physical display presentation.
