# Simulated send after loading older history

The simulated provider exported and reparsed the entire conversation on every
send. With the reported image-heavy transcript, this blocked the send handler
before the scroll glide could start. Persistence now stores a structured tree
snapshot. Validation of untrusted stored data remains on load; readable Markdown
export remains on download/share.

## Workload and scope

This investigation starts in installed Chrome because the report is specific to
Chrome. The user confirmed the LU28R55 display at 1920 × 1080 logical resolution,
2× scaling and 60 Hz, with Chrome maximized. The original private transcript
contains 46 active turns and approximately 26 MiB of data, mostly embedded
images. Its contents are neither committed nor copied into the fixture.

The focused runner imports that file into an isolated simulated-provider
session, presses Page Up until older messages load, presses Page Up once more,
waits for scrolling to settle, then sends. In every comparison run the loaded
range expands from 25–46 to 1–46 before send. The send starts 10,719.5 px from
the old end. A recording without that paging progress is rejected.

Initial exploratory captures that only moved two screenfuls did not load older
history and are not evidence for the clarified case. Remote-provider captures
were also excluded after the user confirmed simulated replies. The generic
streaming analyzer rejects simulated replies because they are not its SSE
fixture; the focused analyzer instead requires a completed send glide and
checks paging, movement, errors, visibility, geometry, and buffer bounds.

## Cause and change

The diagnostic trace attributed most send-time script samples to attachment
validation, `parseTranscriptMarkdown`, and `parseBranchingTranscript`. The
156 ms click handler rebuilt data already held in a validated tree. This work
could delay the first frame and cause the scroll animation to catch up in a
large step. Regular later animation callbacks concealed the initial delay.

`persistSimulatedConversation` now snapshots the tree and active turns directly.
IndexedDB stores the structured tree without an export/import round trip.
Existing Markdown records still load and migrate when saved. Branch choices
remain small separate records tied to the full snapshot revision. Stopped
replies, empty versions, attachments, and alternate branches remain preserved.
This defect belongs to the streaming demo; no renderer dependency patch or
new `markdown-viewer` release is needed.

## Measured comparison

Six timing trials ran in baseline/fixed/fixed/baseline/baseline/fixed order.
All six passed validity checks. Chrome was `153.0.8010.53`; the maximized outer
window was 1920 × 1049 at (1440, 31), with a 1920 × 962 inner window and DPR 2.
DevTools stayed closed. Each trial used a fresh profile and warmed imported
content before measurement. No CPU or network throttling was applied. The
fixture enables sticky headers, end landing/following, and the long text trail.

| Metric | Baseline median (range) | Fixed median (range) |
| --- | ---: | ---: |
| Send preparation | 172.8 ms (166.7–192.7) | 20.0 ms (19.5–20.4) |
| First scroll movement | 223.1 ms (207.5–236.8) | 49.4 ms (45.8–69.4) |
| Send through scroll-command completion | 1200.6 ms (1197.6–1231.4) | 1056.7 ms (1055.4–1061.8) |
| Maximum sampled frame interval | 18.6 ms (18.6–32.4) | 18.6 ms (18.4–18.8) |

Scroll-command completion includes the runtime's settle period. Median
preparation fell 88.4%; first-movement latency fell 77.9%. The glide's
pace remains unchanged. One baseline trial had one interval over 25 ms;
none of the fixed trials did. Most of the improvement is before the glide,
not a general rendering-throughput improvement.

Local baseline IDs: `run-3VXAmY`, `run-pBP3vI`, `run-eJwUV6`. Local fixed IDs:
`run-6X1AEB`, `run-qY9Ojp`, `run-qs1jYJ`. These are compact local records, not
links to uploaded captures. Input size was 27,721,797 bytes; SHA-256:
`92bf94dc5593df2e97e240a90d701f41b74068368d4968c3aae25d1b9907a531`.

## Reproduce

Use the profiler in this report's commit. Baseline application sources are
`demos/streaming/openai.ts` and `demos/streaming/streaming.ts` from `abe966c`.
Restore only those two files in a separate baseline checkout, keeping the same
profiler and locked dependencies. Keep the private input in its original
location and verify its hash against the local `run.json`.

```sh
node scripts/firefox-profile/imported-send.mjs \
  --transcript=/path/to/local-chat.md --display=LU28R55 --refresh-hz=60
```

Use `--mode=diagnostic` for operation attribution. Timing trials use the default
mode. Compact summaries and source replay metadata remain under ignored
`browser-artifacts/imported-send/`; raw traces, screenshots, and helper binaries
are removed after each analysis. The source input is not removed or uploaded.

## Verification

Static checks, unit tests, all 109 portable profiler checks, and the production
build pass. Browser regressions pass in Firefox, Chromium, and WebKit for
structured history and compact branch choices, reload/export, stale selections,
paging and send-after-load persistence, and all three providers' version
histories. The common profiler's stream, phase marks, recording, and manual
export controls also pass.

The focused import/send CLI passes headless correctness checks in all three
engines. WebKit needs scripted viewport paging during setup because Page Up
did not load older history there; this is recorded in the run metadata. Those
headless checks are not native Safari performance evidence.

The user repeated the original interaction in Chrome after reloading the local
demo and confirmed: “Yes, the lag is gone.” This is user verification on the
affected display, separate from the automated timing evidence.

## Limits

The comparison covers send preparation and the glide through landing. It does
not compare random simulated reply timing. Keyboard Page Up establishes the
loaded scrollback state; it does not reproduce trackpad momentum. Animation
callbacks and cached scroll offsets are not physical presentation measurements.
The automated result establishes lower send latency. The user confirmation
applies to this reported scenario; it is not a claim about every browser,
workload, or trackpad gesture.
