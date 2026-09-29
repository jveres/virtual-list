# Clean-code audit and reading-anchor regression matrix

This round starts from `e38dadb`. It reviews runtime reading anchors, the
streaming demo's display-copy lifecycle, and profiling process ownership and
reproduction. The Chrome-specific reports are an explicit exception to the
Firefox-first performance workflow. The closing pass revisits tool-call stability during send and regeneration;
the reported physical flash remains unconfirmed.

## Confirmed findings

The audit fixes these high and medium issues:

| Priority | Area | Failure and correction |
| --- | --- | --- |
| High | Safari memory runner | Cleanup owned a candidate PID before verifying `--automation`. A rejected ordinary Safari process could be terminated. Ownership now starts only after isolation passes. A failing-before/passing-after test covers the rejection path. |
| Medium | Display-copy worker | Worker errors left requests pending; posting failures produced unhandled rejections. Failure now disables the worker, settles outstanding requests, and retains original images. Individual conversion failures release their cache entries so they can retry. |
| Medium | Reading anchors | Browser boundary rounding became an explicit replacement offset and enlarged trailing reserve. Captures now clamp to the modeled scroll range, and near-pinned replacements normalize to the inset. |
| Medium | Clipped replacements | A partially visible prompt yielded ownership to its reply and jumped by the version height difference. The first visible replacement now retains ownership, with a measured visibility fallback for shorter replacements. |
| Medium | Disclosure collapse | An explicit viewport anchor could clamp after content shrank because no supporting reserve was created. Surviving explicit viewport anchors can now retain the required space. |
| Medium | Bottom navigation | Temporary reading reserve became the destination for bottom commands and fast reversals. End commands now target content/current pin, and wholly unused reserve drains before settlement. |
| Medium | Clipped pin collapse | Collapsing the clipped final prompt at the end retained an expanded-row offset. If the shortened tail fits, the runtime now restores its pin; other reading positions remain unchanged. |
| Medium | Send profiling | The reproduction recipe invoked a different profiler, and the setup could use replay history instead of default chat. The runner now records its exact command, selects the simulated provider at boot, and validates the 102-message fixture. It supports sending from the bottom with Enter. |

## Version-switch reproduction

The affected browser was Chrome 154.0.8037.58, maximized on the LU28R55:
1920 × 1080 logical display, 2× scaling, 60 Hz. The browser viewport was
1920 × 962. Its scroll container measured 812.6015625 CSS pixels tall while
`clientHeight` returned 813.

The decisive manual capture changed both the final prompt's versions and its
assistant reply's versions, with repeated scrolling away and back. Switching
only prompt versions missed the remaining failure.

1. The modeled bottom was 12363, but the physical landing was 12363.5.
2. Switching an assistant version captured its offset as 259.5 instead of 260.
3. That explicit offset enlarged the modeled total from 13176 to 13176.5.
4. Returning to the end reached 12364. The prompt was now at 39 instead of 40.
5. Switching the prompt chose the reply as its anchor. The prompt moved from
   39 to 111 pixels: a 72-pixel jump matching the versions' height difference.

Normalizing only the prompt's pin tolerance was insufficient: assistant
replacements could still enlarge the reserve. The correction belongs in the
runtime's reading-anchor companion, before replacement offsets reach geometry.
It leaves genuine mid-viewport offsets intact. The subsequent clipped-message
investigation below revises the old rule that yielded to the visible reply.

The user confirmed the complete mixed sequence fixed. Automated checks cover
both prompt and assistant versions, repeated scroll gestures, and switches
with the prompt in the middle of the viewport.

Capture the interaction without DevTools:

```sh
node scripts/firefox-profile/version-anchor.mjs --display=LU28R55 --seconds=90
```

The runner announces when recording starts. It uses a fresh Chrome context and
closes its owned browser and server. It retains bounded per-action outcomes and
reproduction metadata under ignored `browser-artifacts/`, not a raw profile.
Geometry reads occur at version actions, not in an animation-frame sampler.
This diagnoses anchoring correctness; it is not a scrolling performance test.

### Older prompt under the date pill

A later report adds a new turn, then returns to the earlier prompt and changes
its version. The original checks kept the prompt below the sticky inset and
missed this case. With version 2 at 30 pixels inside the 40-pixel date band,
switching to version 1 moved its top to -42 pixels. The helper chose the reply
as the replacement anchor; the prompt versions differ in height by 72 pixels.

The first correction preserved tops inside the viewport but still yielded to
the reply when the prompt was clipped. The user then supplied a stronger
reproduction: send `fast`, scroll back to the previous prompt during streaming,
wait for completion, and change that prompt's version. At offset -24, the
stream itself preserved the position; switching moved the prompt to 48 because
the helper selected its reply at offset 196. This was an anchor-selection rule,
not a streaming-completion reserve change.

The companion now preserves the first intersecting source message, including
negative offsets. An optional `visibilityInset` on the explicit anchor lets the
geometry kernel reveal a replacement only if its measured height would leave
it fully hidden. Exact-offset anchors without that option keep their existing
contract. No demo workaround or per-frame layout read is added.

The older-version regression now runs real incremental `fast` streaming, moves
away before completion, then repeats version switches at clipped, under-pill,
and mid-viewport placements. Geometry tests cover replacements that remain
visible and replacements too short to preserve the old offset. Existing footer
cases now assert that the selected replacement is revealed, rather than that
its successor owns the anchor.

Standalone Firefox launches failed before page startup. The repository runner
already supplies the required isolated app-data setup; launching through
`pnpm run test:regression` resolves that environment issue.

### Collapse after scrolling past the prompt pin

The user confirmed the streaming/version fix, then reported: expand the last
default prompt, scroll to the bottom, and collapse it. At a 1920 × 962 viewport,
2× scaling, the expanded prompt's top was 5 pixels. Collapse reduced its height
from about 540 to 220 pixels; the top then jumped from 5 to the 40-pixel pin.

This was a separate geometry defect. The explicit `viewport` request preserved
the surviving reading anchor mathematically, but reserve could only grow to
support a named replacement. The resulting shorter scroll range clamped the
position. The geometry kernel now adds reserve when an explicit viewport
request needs it to preserve a surviving anchor. It adds no reserve when the
resolved position already fits, and the extra space drains after scrolling
away. Automatic end-follow and removed-anchor fallback retain their policies.
The demo's collapse handler is unchanged.

The exact disclosure sequence now preserves the 5-pixel top in Chromium,
Firefox, and WebKit. A geometry regression covers initial zero reserve, shrink,
stable settlement, and later release of the extra space.

### Returning to the bottom after mixed changes

Inspection of the user's open Chrome tab found the final collapsed prompt at
-113.5 pixels at the physical bottom, with about 321 pixels of blank trailing
space. Pressing the bottom button preserved that incorrect position. Temporary
reading reserve had become the command's destination.

End navigation now targets the greater of the natural content end and the
current prompt pin, excluding temporary reading reserve. Reading changes can
still preserve their exact position. Once scrolling moves entirely above that
extra space, the runtime releases it before settlement, so reversing direction
cannot return to an obsolete bottom. This uses the existing scroll snapshot
and avoids new layout reads in the scroll handler. Pending measurements,
commits, and native glides retain their existing protection.

The disclosure regression checks both the stationary reading position and an
up/down reversal before settlement. Separate runtime checks cover smooth and
instant end commands. These corrections belong to the runtime; the demo's
version and collapse handlers are unchanged.

The broader history regression caught an overreach in the initial correction:
internal width reflow also uses viewport anchoring, but must clamp to the content
range instead of creating reading reserve. Resizing from 390 pixels wide to
1500 left 432 pixels of blank space. Internal reflow now opts out of creating
that extra reserve; explicit host changes retain the continuity guarantee.
A geometry test and the history-tail browser regression cover the distinction.

### Clipped prompt collapse at the bottom

A later user report exposed an incorrect expectation in the initial matrix.
With assistant version 2 selected, expanding the prompt and reaching the bottom
puts its top at -113 pixels. Collapse preserved that offset, even though the
shortened tail could fit below the 40-pixel pin. The old matrix accepted that
preservation as correct; it did not prove that the prompt's top was reachable
without another gesture.

For an explicit viewport change at the end, the geometry kernel now restores
the pin when the captured pinned row shrinks, its top was clipped, and its
shortened tail fits below the pin. Away from the end, unpinned rows, and rows
whose tops are already visible keep their reading position. No demo handler
changes are required. The focused browser regression now covers assistant
versions 1 and 2 in all three engines: 5 → 5 pixels and -113 → 40 pixels,
respectively. The combination matrix uses the corrected expectation.

### Combination coverage

The bounded matrix enumerates all valid combinations of the selected dimensions,
rather than claiming to cover every possible interaction sequence:

| Layer | Dimensions | Cases |
| --- | --- | --- |
| Geometry | Three viewport heights, two insets, three prompt heights, three reply heights, six offsets, four replacement heights, same/replaced key, pinning on/off; only intersecting source rows | 4,464 |
| Browser | Seven valid prompt/reply/disclosure states, all available version/disclosure actions, four placements (pin, clipped, middle, bottom), three engines | 252 |

Browser cases run sequentially in the same document to retain accumulated
state. Each case checks the reading position, native bottom navigation, and
two scrolling round trips with actual movement verified before reversal.
The streaming regression separately covers an older prompt after a new `fast`
reply, including movement before streaming finishes.

These are automated correctness tests using Chromium, Firefox, and WebKit at
1920 × 962 CSS pixels and 2× scaling. They do not measure physical trackpad
presentation or substitute for installed Safari. Firefox's scripted wheel
input can omit its protected-edge release event; the harness explicitly ends
the input phase at case boundaries, after checking each reversal's outcome.

Run the reusable matrix with:

```sh
pnpm run test:regression -- --match=chat-anchor-combinations --timeout=1200
```

## Enter-to-send check

Use the same display and default simulated history, already at the bottom:

```sh
node scripts/firefox-profile/imported-send.mjs --position=bottom \
  --submit=enter --display=LU28R55 --mode=diagnostic
```

Two matched captures use prompt landing and validate `loaded 73-102/102` before
sending. The diagnostic capture observed one native smooth-scroll request and
no corrective writes during the glide. It recorded 9.1 ms preparation, 739.3 ms
to landing, no long tasks, and a maximum animation-callback interval of 17.6 ms.
The timing capture recorded 8.5 ms preparation, 720.1 ms to landing, and the same
maximum callback interval.

Presentation telemetry also showed gaps up to 57.621 ms. These records do not
independently measure physical display smoothness, and regular callbacks do not
prove it either. The user reported the current Enter-to-send animation smooth.
No separate send-animation performance patch or causal claim is made.

Two exploratory captures are excluded: one used end landing; the other retained
the profiler's replay conversation. Their local metadata marks the mismatch.
The matched diagnostic and timing runs are retained as compact summaries with
commands, revision, patches, hashes, browser build, and display geometry. Raw
Chrome traces and CPU profiles were deleted after analysis.

## Debug-flag audit

The runtime has no URL-controlled debug branches. The streaming demo retains
`debug-compositing=no-message-layers,no-canvas-layer`: these controls are still
used by `scripts/profile-memory.mjs` and documented in the memory-profiling
workflow. Removing them would invalidate the supported layer comparisons.
The instant/fast-long stream controls and trail override have browser-regression
consumers. Feed query parameters configure its source and paging limits.

No obsolete runtime or demo debug flag was found. Profiler-only compositing
controls remain isolated in the capture scripts and fixtures; they do not add
branches to the normal demo. Historical report URLs describe past experiments
and are not evidence that those flags still exist.

## Verification

The broader run exposed three stale conversation-tree assertions. An isolated
checkout of unchanged `e38dadb` reproduced the same three failures. The imported
fixture contains 120 linear nodes plus five alternatives, so its expected count
is 125, not 122. The default tree now has four nodes at its widest depth rather
than three. Nested branches pack descendant contours; every neighboring
node does not necessarily have a 12-pixel gap. The updated assertions check
nonoverlap, a packed gutter, and centering by actual parent instead of treating
every node at the same depth as a sibling. The placement test also retained
references to a removed badge; those obsolete checks were removed. No tree
runtime change was needed.

The current candidate passes TypeScript/Biome and all 5,613 unit tests in
54 files, including the 4,464 geometry combinations. All 252 sequential browser
combinations pass: 84 each in Chromium, Firefox, and WebKit. The full matrix
completed in 354.0 seconds after the clipped-collapse correction. The focused collapse/reversal reproduction also
passes in all three engines.

All 145 portable profiling checks and 11 regression-runner checks pass.
Existing CSS diagnostic-override/specificity warnings and the dependency's
missing-source sourcemap warning remain. Full earlier browser runs were
interrupted when new reproductions arrived; they are not completed validations.
All 122 browser regression scripts have passing results across the grouped
runs and targeted reruns. The broader 103-script run initially passed 99 and
failed four: the three stale tree tests and the history resize case described
above. Each failed script subsequently passed after correction. The 18 other
scrolling scripts and the 252-case matrix also passed. This is an aggregate of
the completed runs, not a claim that the initial full run passed unchanged.

Reproduce the complete browser suite with `pnpm run test:regression`. The new
matrix, collapse/reversal, older-prompt streaming, and mixed-version regressions
live under `scripts/regressions/`; geometry combinations live in
`tests/unit/anchor-combinations.test.ts`. Compact per-script results are retained
under ignored `browser-artifacts/anchor-audit/`. Temporary baseline checkouts,
raw diagnostic probes, generated screenshots, and reproducible Swift caches
were removed. Owned browsers and servers exited; the existing demo server and
user browser sessions were preserved.

The closing audit found no additional confirmed high- or medium-priority
issues after the clipped-collapse correction. Remaining debug controls have
active profiling or regression consumers; no obsolete runtime flag was found.

The tool-call regression now covers both sending and regenerating a simulated
reply in all three engines. It checks row/node identity, effective opacity and
visibility through the thinking-to-text transition, and lack of answer focus.
It also verifies that tool calls survive page reload. These checks pass without
a demo workaround. They do not measure physical compositor presentation or
prove that the earlier intermittent visual flash cannot occur.
