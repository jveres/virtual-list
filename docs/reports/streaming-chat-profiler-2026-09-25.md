# Streaming chat profiling method verification

This report verifies the profiling tools added on top of `4dfe979`. It does
not claim a production performance improvement. Runtime and demo source files
are unchanged; a temporary Vite server applies diagnostic overlays in memory.
The [profiling guide](../streaming-chat-profiling.md) gives commands, metric
definitions, comparison controls, and the manual Safari workflow.

## Workload and environment

The default local SSE response contains 44,230 text characters in 461 chunks
and 466 total events. It includes tables, code, math, lists, quotes, local SVG
images, a reasoning summary, and a search-tool panel. The history contains
160 turns. Response deadlines span 12 seconds, followed by idle settling.
The renderer trail is `long`, sticky headers are enabled, and the list starts
at the end. The input hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

Installed Firefox 156.0.1 (build 20260921121718) and Chrome 153.0.8010.53 ran
on macOS 27, on the LU28R55 external display at 2x scaling and 60 Hz. Both
windows had outer dimensions 1900 × 1049 at (1450, 31). Firefox's content
area was 1900 × 965; Chrome's was 1900 × 962. Each run used a fresh browser
profile with DevTools closed. Browsers were measured sequentially.

## Native capture checks

Compact summaries remain locally under `browser-artifacts/chat-profile/`.
Raw captures were removed after analysis. Each listed
run completed the local stream, recorded movement, and passed the recorder's
validity checks. Timing mode keeps the common recorder and native profiler;
diagnostic mode adds synchronous operation spans, DOM-access counters, and
mutation observation.

| Local run | Scenario / mode | Moving intervals | Moving p95 | Moving maximum | Moving intervals >25 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| `firefox-timing-v1leD5` | Follow / timing | 761 | 17.14 ms | 33.96 ms | 3 |
| `firefox-diagnostic-ncbqzl` | Follow / diagnostic | 742 | 17.26 ms | 250.12 ms | 4 |
| `firefox-diagnostic-gEySZk` | Native scrollback / diagnostic | 859 | 17.18 ms | 17.50 ms | 0 |
| `chrome-timing-jJ2l4r` | Follow / timing | 686 | 33.30 ms | 466.40 ms | 51 |
| `chrome-diagnostic-9bGKlg` | Follow / diagnostic | 667 | 33.30 ms | 183.40 ms | 47 |
| `chrome-diagnostic-wf9HnX` | Native scrollback / diagnostic | 630 | 33.40 ms | 50.10 ms | 91 |

These individual trials validate collection and analysis. They do not establish
an overhead percentage, rank browsers, or demonstrate jitter-free physical
presentation. In particular, the Chrome timing control still contains long
intervals. Repeated interleaved trials and native trace inspection are needed
to attribute those stalls.

The Firefox scrollback run recorded 899 wheel events and 17 scroll-end events.
Its retained range progressed from turns 133–160 of 160 to 109–162 of 162,
so this capture exercised paging while streaming. The maximum interval across
all frames was 49.48 ms, outside the moving-frame subset. Native gestures were
scripted macOS events, not real trackpad momentum.

Chrome scrollback recorded 705 wheel events and 13 scroll-end events. Its
retained range did not cross a paging boundary, so that run validates native
input during streaming but does not validate Chrome paging cost.

## Attribution checks

The Firefox diagnostic follow report recorded 467 message-content updates
with 562 ms aggregate self time, and 489 virtual-list commits with 210 ms
self time. Four updates supplied unchanged text to the same content host.
They are investigation candidates: tool, cursor, mount, or geometry changes
can still make such updates necessary.

Chrome's diagnostic follow report placed `liveCommit` first by instrumented
self time (about 1,108 ms across 1,844 calls), followed by message-content
updates (about 893 ms across 467 calls). Its V8 samples include substantial
time at `scrollTop` access. The timeline analysis and long-animation-frame
summaries allow checking whether those accesses coincide with style/layout work.
DOM access counts alone cannot establish a forced layout.

Chrome supplied native style, layout, paint, script, and presentation records,
plus long-task and long-animation-frame entries. Firefox supplied Gecko
profiles, sampled thread CPU, stacks, and burst summaries. Unsupported common
Performance Observer entry types are reported as unavailable. Inclusive spans
overlap, and V8 sampled wall time is not CPU utilization.

## Safari startup fix and verification

The initial installed-Safari attempts timed out before navigation, including
an attempt restricted to `platformName: macOS`. A minimal `curl` request
reproduced the failure and received the driver's full error after 30 seconds.
Safari's automation log identified the cause: the HTTP driver selected the
regular Safari process, which rejected the session because it was not launched
for automation. Launching a separate automation process first did not correct
the HTTP driver's selection. Remote Automation was already enabled.

Safari 27.0 (22625.1.29.11.27) successfully creates isolated sessions through
its built-in `safaridriver --mcp` interface. The runner now detects that support
and uses it. The obsolete HTTP adapter was removed; older Safari versions can
use the standalone manual recorder. The runner requires one new
Safari process with the `--automation` argument, places only that process's
window, and verifies closure after ending the session. Native window placement
waits for the display move before resizing, preventing the initial height from
being clamped to the built-in display. No preference or regular browser session
is changed.

The Safari timing control `safari-timing-UWmOBd` completed all 44,230 characters
and 461 chunks. It recorded 760 moving intervals, a moving p95 of 20 ms, and a
maximum of 45 ms. Its external-display window was 1900 × 1049 at (1450, 31),
with a 1900 × 945 content area, 2x scaling, and 60 Hz refresh. Its driver,
automation browser, and server all closed successfully.

The native scrollback run `safari-diagnostic-DZFt03` also completed the stream
at that geometry. It recorded 702 wheel events, 14 scroll-end events, and 700
moving intervals (p95 18 ms, maximum 32 ms). It did not cross a paging boundary.
The earlier MCP follow trial `safari-diagnostic-8hOmcm` completed too, but had
a shorter 1900 × 869 window and is not a matching geometry control.

A repeat exposed an automation app that remained alive after its tab and driver
closed. Cleanup now verifies the recorded process identity and terminates only
that owned automation instance. The subsequent `safari-diagnostic-54Tnjw`
completed native scrollback with 685 wheel events, 13 scroll-end events, and
681 moving intervals (p95 20 ms, maximum 37 ms), with browser, driver, and server
closure verified. Interrupting `safari-diagnostic-c7yMx6` also closed all owned
resources. Signal handlers remain installed through cleanup because the
terminal and package runner can both forward an interrupt.

MCP permits native user input, unlike the legacy WebDriver glass pane. It uses
an Inspector connection internally, so its overhead must remain part of the
comparison conditions. The report records the transport and refuses to compare
different transports. These are tool-verification trials, not a measured jitter
fix. Real trackpad momentum and physical presentation still require manual
verification. The standalone keyboard workflow provides a control without the
MCP connection, and a separate Web Inspector Timelines export provides native
Safari attribution.

Failed HTTP attempts are identified as `safari-diagnostic-I1GbtY`,
`safari-diagnostic-LpL3gu`, and `safari-diagnostic-2OBBOM`. Their compact failure
metadata remains; obsolete startup probes and raw logs were removed.

An early Firefox run lost foreground focus (`firefox-timing-ohd0oQ`), and a
compiler-cache experiment failed before browser launch
(`firefox-diagnostic-q3tssz`). Both are excluded. Canonicalizing the shared
Swift cache path fixed the compiler failure; the later native scrollback run
used that correction successfully.

## Verification and ownership

Portable checks cover deterministic input, source-transform drift and exception
handling, bounded telemetry, wrapper restoration, invalid or incomparable
captures, and Chrome trace attribution. Browser regressions cover full local
streaming and operation attribution in Firefox, Chromium, and WebKit. They also
exercise keyboard export and deterministic history restoration in WebKit.

Required commands are `pnpm run check`, `pnpm test`,
`pnpm run test:firefox-profile`, and
`pnpm run test:regression -- --group=runtime --match=chat-profiler`.
All passed: lint/types, 1,041 unit tests, 104 portable profiling checks, and the
browser regression across three engines plus keyboard/export verification.
The unit suite needed localhost listener access; its first sandboxed attempt
failed on `listen EPERM` in the existing relay tests, and the permitted repeat
passed all 48 files.

Capture servers, fresh browser sessions, native helpers, and failed Safari
drivers are owned by the runners and closed on completion or failure.
The final process audit found none of those owned processes left running.
Pre-existing browser and development-server processes were preserved.

## Reproduction and retention

Both native Firefox and chat captures now analyze their temporary raw files and
remove them after completion or failure. The Firefox subprocess transfers raw
files to its chat parent only long enough for that parent's analysis. Retained
files contain compact results, environment metadata, an exact command, source
hashes, and a patch against the recorded revision. A portable check reconstructs
modified, staged-deleted, and untracked source from that patch.

Short follow captures `safari-diagnostic-O6eQkq` and
`firefox-diagnostic-EtsAlK` verified the cleanup path with 12 reply sections,
40 history turns, and a four-second stream. Both completed with movement and
retained only summaries and source replay files. These smaller trials verify
the tools; they are not controls for the full workload above.
Chrome `chrome-diagnostic-8RD8HQ` passed the same short workload and retained
29 named native thread summaries after deleting its trace. The standalone
Firefox trial `run-BHSt40` also analyzed and deleted its raw capture, with
59 scroll events and one scroll-end event.

Older development trials predate source-patch recording. Their workload and
production revision remain known, but their exact uncommitted instrumentation
cannot be reconstructed. New captures remove that limitation. Reproduction
still requires a matching installed browser, display, and window; OS scheduling
and physical gestures are not deterministic.

The cleanup removes obsolete trial data, screenshots, compiler caches, and
temporary probes, reducing local artifact storage from 1.68 GB to 5.3 MB.
Historical reports and reusable fixtures remain tracked.
Browser-specific optimization is supported by native Firefox CPU/stacks,
Chrome renderer and other-thread summaries, and Safari operation attribution
with an optional separately analyzed Web Inspector timeline. New questions can
extend the analyzers and rerun the fixture without retaining raw archives.
