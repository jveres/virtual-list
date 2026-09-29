# Canvas and message compositing comparison

Keep the current canvas hints enabled for now. In the installed Safari text
workload, removing them raised the largest process peak from 720 MiB to more
than 1,600 MiB. Removing message hints as well did not avoid that spike.
Firefox showed no meaningful memory saving from removing the canvas hint.
These are single trials per configuration, not a statistical estimate of a
small performance difference. Production defaults are unchanged.

The user reports no visible scrolling-performance difference with
`no-message-layers` in any browser. That flag removes message `will-change`,
but retains the canvas transform. It was never a GPU on/off comparison.

## What the controls change

The browser still chooses compositing for scrolling and other content.
[`will-change`](https://www.w3.org/TR/css-will-change/) is a rendering hint;
removing it does not disable GPU acceleration. WebKit exposes actual layers in
its [Layers tab](https://webkit.org/web-inspector/layers-tab/), but DevTools
remain closed during these memory captures.

| Control | Message hint | Canvas transform | Canvas transform style |
| --- | --- | --- | --- |
| Current Safari | `transform` | `translateZ(0)` | `preserve-3d` |
| Canvas off | Unchanged | `none` | `flat` |
| Canvas and messages off | `auto` | `none` | `flat` |

Chrome and Firefox's idle message hint is already `auto`; their default canvas
style is `flat`. Image hints remain unchanged in every control. Computed styles
are recorded at checkpoints, with no animation-frame layout sampler. A separate
headless check verifies all three configurations in Firefox, Chromium, and WebKit.

## Measurement corrections

Safari's previous process collector included every new WebKit process. A probe
confirmed that this could include services belonging to other applications.
The collector now resolves the responsible application and includes only the
isolated Safari process and its services. The helper fails closed if ownership
cannot be established. The private macOS API is also used by
[Chromium's process code](https://chromium.googlesource.com/chromium/src/+/24aa2a50ac03698e7ec5a11251a615b965f5874d/base/process/process_info_mac.cc).
Older Safari totals may be contaminated and are not the decision baseline here.

The focus helper now runs the AppKit event loop while waiting for activation,
instead of repeatedly reading potentially stale activation state. This follows
[Apple's application-state guidance](https://developer.apple.com/documentation/appkit/nsrunningapplication).
Two subsequent Safari text attempts lost focus during capture and were rejected
before any completed cycle. Valid trials began after the user made the desktop
available. No focus or visibility failure is treated as a passing measurement.

## Safari results

All three valid trials use Safari 27.0, build 22625.1.29.11.27, on macOS 27.0
build 26A428. The LU28R55 is 1920 × 1080 logical pixels, DPR 2, at 60 Hz.
The browser is at 1440, 31 with outer size 1920 × 1049 and content viewport
1920 × 945. Each fresh session runs twelve cycles of the default 102-message
chat. Every cycle visits all 102 keys. DevTools are closed.

Peak is the largest owned process's lifetime physical footprint. Final-cycle
memory is the median whole-browser footprint of the last three cycles. Idle
memory is the whole-browser footprint ten seconds after scrolling ends.
These counters include allocations beyond JavaScript and can include shared
accounting; they are not GPU-memory or unique-RAM measurements.

| Configuration | Largest process peak | Final-cycle median | Idle | Gate |
| --- | ---: | ---: | ---: | --- |
| Current | 720 MiB | 595 MiB | 369 MiB | Pass |
| Canvas off | 1,682 MiB | 396 MiB | 395 MiB | Peak failure |
| Canvas and messages off | 1,666 MiB | 434 MiB | 429 MiB | Peak failure |

The large peaks belong to the WebContent process, not simply the process named
GPU. They appear during traversal: the canvas-off run's peak before traversal
was 291 MiB. A lower between-cycle reading would miss the transient cost.
The 768 MiB process-peak budget was not raised. Both off variants settle within
the growth and final-range budgets but fail the peak budget.

This comparison supports retaining the canvas hints together. It does not
isolate `translateZ(0)` from `preserve-3d`, establish why the allocation occurs,
or determine whether removing only message hints helps when the canvas remains
promoted. There is no new valid message-only Safari trial in this round.

## Firefox control

Firefox 156.0.1, build 20260921121718, runs on the same display, with content
viewport 1920 × 965. Each fresh session runs six cycles through the synthetic
48-message image fixture. All rows and all 24 image rows are visited and decoded.
The image workload differs from Safari's text workload; compare configurations
within a browser, not absolute totals between these tables.

| Configuration | Largest process peak | Final-cycle median | Idle | Gate |
| --- | ---: | ---: | ---: | --- |
| Current | 472 MiB | 1,201 MiB | 1,167 MiB | Final-range failure |
| Messages off | 474 MiB | 1,193 MiB | 1,154 MiB | Final-range failure |
| Canvas off | 483 MiB | 1,220 MiB | 1,191 MiB | Pass |

The first two trials have identical recorded message hints (`auto`). Their
46 MiB and 43 MiB final ranges exceed the 40 MiB settling limit while memory
continues to decline. All other budgets pass. These failures remain recorded;
small differences between these runs do not establish a benefit from the flag.
Canvas removal also provides no observed memory saving in this comparison.

Chrome's reported Task Manager difference of 89 MB versus 149 MB remains an
uncontrolled user observation. Chrome's idle message styles are identical with
and without the message flag. No new installed-Chrome canvas-memory comparison
was run in this round, and no Chrome memory benefit is claimed.

## Reproduce and interpret

Use the [memory workflow](../memory-profiling.md). Each cycle contains 80 upward
and 80 downward 900-pixel instant steps, 40 ms apart, with 700 ms edge waits.
This stresses allocation and recycling; it is not a physical momentum or frame
presentation benchmark. The user's visual comparison is separate evidence.

```sh
pnpm run test:memory -- --browser=safari --workload=text --cycles=12
pnpm run test:memory -- --browser=safari --workload=text --cycles=12 --canvas-layer=off
pnpm run test:memory -- --browser=safari --workload=text --cycles=12 --canvas-layer=off --message-layers=off
```

For the Firefox configurations, use `--browser=firefox --workload=images
--cycles=6`, first with no override, then with `--message-layers=off`, then with
`--canvas-layer=off`. Start with Firefox when beginning a new investigation.

Compact summaries and source snapshots against revision
`888fbfd7061dd08a1f0c57293ce1cf7cd0661c61` are under ignored
`browser-artifacts/memory/`. Raw captures, per-run helpers, server caches, and
temporary browser profiles are removed. The source snapshots include the
preceding memory and scroll fixes; the revision alone does not reproduce them.

| Configuration | Artifact directory |
| --- | --- |
| Firefox current | `firefox-images-zqgrCk` |
| Firefox messages off | `firefox-images-vPKbQ5` |
| Firefox canvas off | `firefox-images-Np8Ukw` |
| Safari current | `safari-text-t6WW5u` |
| Safari canvas off | `safari-text-7XCPGz` |
| Safari canvas and messages off | `safari-text-ZjCtCy` |
| Safari interrupted current | `safari-text-LxOkq0` |
| Safari interrupted messages off | `safari-text-x8KZeD` |

The final code check passes with the existing boundary-spinner specificity
warning. All 1,117 unit tests and 143 portable profiling checks pass. The three
debug configurations pass computed-style checks in all three browser engines.
The final process audit finds no remaining capture runner, automation Safari,
Safari driver, or sleep assertion. The pre-existing development server and
regular browsers remain running.
