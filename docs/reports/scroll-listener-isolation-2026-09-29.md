# Scroll listener isolation, September 29, 2026

## Conclusion

Close this investigation at the user's request. The working classification is a
browser/macOS presentation issue on the external-display setup, not an
established virtual-list defect. The user reports that Chrome never exhibits
the jitter; Firefox and Safari do. That difference prevents attributing the
problem to macOS alone without isolating the browser and OS rendering paths.

Firefox also reproduces the intermittent jitter on the plain static fixture,
without the virtualizer, chat layout, or scroll/input handlers. None of the
listener or CSS comparisons produced a lasting, repeatable fix. A fresh load
is consistently smooth according to the user. No speculative runtime fix is
adopted, all temporary chat CSS overrides are removed, and further investigation
is stopped. The minimal fixture remains available for browser/OS reproduction.

## Observations

The external-display jitter remains unresolved. The user initially saw no
difference with row recycling suspended or scroll callbacks bypassed. Removing
the listeners themselves later appeared to help in Firefox and Safari, but an
alternating comparison did not consistently reproduce that difference. A later
observation again favored removing listeners. These observations keep the
listener hypothesis open; they do not establish a JavaScript bottleneck or a
compositor defect.

The user subsequently observed immediate improvement from removing either
listener group in Firefox, and from removing both groups in Safari. A later
Firefox episode still jittered with both groups removed. Listener removal is
therefore not a reliable fix, and scroll/input callbacks cannot explain every
reported episode. Other JavaScript is not disabled by these controls.

The user also reports that jitter often starts after an idle period, even when
scrolling becomes smooth immediately after a CSS hot update. This is a possible
confound in the sequential CSS comparisons: an update may temporarily affect
the rendering state independently of the changed rule. It is not evidence of a
specific cache, GPU power state, or browser defect.

The same-CSS control below produced no visible difference when the user tested
it during a subsequent jitter episode. Refreshing an unchanged stylesheet is
therefore not an observed remedy; the earlier apparent improvements remain
inconclusive.

No production runtime change follows from this experiment. The development-only
instrumentation is opt-in and preserves a way to repeat the comparison in the
same browser session without restarting the browser or opening DevTools.

## Compare the listener groups

Open the streaming demo with `?scroll-isolation`. Stop streaming and scrolling,
then select a mode in the diagnostic panel. Preparation mounts up to six
viewport heights on either side of the current position, with a hard limit of
64 measured rows. The controls use the original row nodes and styles.

| Control | Behavior inside the prepared region |
| --- | --- |
| Normal | Normal recycling and listeners. |
| Retain rows | Fixed mounted region; scroll and input handlers remain active. |
| Pause scroll work | A passive capture guard prevents events reaching the list; the guard still runs. |
| Remove scroll events | Detaches `scroll` and `scrollend` listeners, including the guard; input listeners remain. |
| Remove input events | Detaches wheel, touch, pointer, and key listeners; scroll listeners remain. |
| Remove all listeners | Detaches both groups, including the guard and any matching diagnostic listeners. |

**Reapply same CSS** replaces the development stylesheet's text with the exact
same text, using the existing style element. It preserves the selected listener
mode, mounted rows, and CSS rules. Use it once jitter is present, then compare
immediate scrolling and scrolling after the usual idle period. It does not
reload the page or install a timer, sampler, or scroll handler. A response to
this control alone would support the refresh effect, not a specific layout fix.

Listener removal covers the viewport, document, and window. Ordinary callbacks
are registered without dispatch wrappers. The registry preserves duplicate,
capture, once, explicit removal, and abort-signal behavior. Listeners registered
while their group is disabled stay detached until that group is restored.
Retired message elements are not retained by the registry.

The two modes that remove scroll events have no automatic region-boundary
recovery. Stay in the prepared region and select **Normal** to restore it. Moving
beyond the region can expose empty space. Interaction with another control,
viewport resizing, or a content mutation can also restore normal operation.
Other page JavaScript, observers, browser rendering, and native input processing
are not disabled. This is not a claim that all JavaScript has stopped.

Compare the same short stretch after the same wait in each mode. Watch the
status to confirm that the selected mode remains active. Use at most three
trials per browser in a comparison round. Changes to the development server's
configuration can reload the page: finish updating the experiment before a
manual comparison and do not treat observations across a reload as matched.

The earlier combined-removal button was labeled **Remove scroll listeners**.
It removed input listeners too. Its observations cannot distinguish the groups.
The first preparation implementation also retained too short a region when the
runtime reused its cached range. Preparation now invalidates that cache before
mounting; browser checks require the larger region to exist.

## Scroll surface review

A separate headless Firefox geometry inspection used a 1900 × 964 viewport at
device scale 2. At the middle of the default simulated chat's loaded window it
found an approximately 815-pixel-high scroller and a 860 × 13,178 CSS-pixel
content canvas. No active animations, filters, or backdrop filters were found
inside that idle scroll area. This is a layout inspection, not a physical
external-display or installed-Firefox performance measurement.

The remaining structural candidates include the canvas's `translateZ(0)`,
clipping and containment around rows, nested code/table scrollers in Firefox,
and compositing of overlays. Safari additionally uses `preserve-3d` on the
canvas and message-level transform hints. Removing those hints is not an
established fix: the earlier [compositing comparison](compositing-memory-2026-09-29.md)
recorded substantially higher Safari memory peaks with its canvas hints off.

A Firefox-only CSS comparison removed `overflow: clip` from mounted message
slots while keeping hidden measurement slots clipped. A focused headless check
confirmed identical positions for 25 rows, a 13,178-pixel scroll height, and zero
attached tracked listeners. The user still saw jitter. The clip override was
removed.

The next Firefox comparison removed only the canvas's `translateZ(0)`. The user
reported the same jitter, so that override was also removed.

Removing `contain: layout style` from Firefox message rows also left the jitter
unchanged, according to the user. That override was removed.

Another comparison hid the sticky date header, edge overlays, and jump-button
layer. The first version also hid the diagnostic toolbar. The user reloaded and
reported hard jitter, but that reload re-enabled the listeners. After the
toolbar was restored and the user was asked to remove listeners again, they
still reported jitter. The overlay override was removed.

A final CSS comparison changed mounted message contents from absolute to
relative positioning, preserving fixed-height slots, clipping, containment,
canvas hints, overlays, and the original hidden-row positioning. The user first
reported that hard jitter was gone, with a small line-height stutter during
momentum deceleration. Hard jitter then returned without another CSS change.
The relative-position override was removed. All production CSS is restored;
none of these intermittent observations establishes a layout fix.

Height alone does not imply a backing bitmap of that entire size. Firefox's
[rendering overview](https://firefox-source-docs.mozilla.org/gfx/RenderingOverview.html)
describes scene culling, clipping, and asynchronous scrolling, and its
[picture-cache implementation](https://doc.servo.org/webrender/picture/index.html)
describes tiled caching. The actual rendering cost must be measured.

## Static height control

The existing static fixture now supports a CSS-only height comparison:

```text
http://localhost:5173/scripts/firefox-profile/fixtures/static-scroll.html?height-control=1&layer=1
```

It builds 30 rows once. Its checkbox adds or removes 40,000 CSS pixels of empty
space below the same rows without reloading. Compare those rows away from the
bottom; do not judge the different boundary behavior. No scroll, input, or
change listener implements this control. The existing `layer`, `code`, and
other fixture switches remain available for separate comparisons. No user
result is inferred from automated frame timing.

The user initially saw no jitter with extra height off and a noticeable
difference with it on. Jitter subsequently persisted with the checkbox off.
After reloading, scrolling was smooth again, and enabling extra height brought
jitter back. This suggests testing both scroll extent and changes to that
extent; it does not yet identify a browser cache, rendering layer, or layout
defect. The static fixture demonstrates that an episode can occur without the
virtualizer or chat-specific layout.

Add `&start-tall=1` to load the same 30 rows with the extra 40,000 pixels already
present. Compare initial scrolling without touching the checkbox. This separates
a tall initial surface from growing the surface after loading. The checkbox
still changes height through CSS alone; no event handler or sampler is added.

The user declined that comparison and requested the cheapest tall-spacer CSS.
The spacer already had no background, border, shadow, filter, transform, or
layer hint. The current candidate also sets its width to zero, hides its
visibility, and excludes it from scroll anchoring, while preserving its normal
flow height. It remains empty and cannot receive pointer input. This removes
the spacer's paint and hit-test participation; it does not remove the enlarged
scroll extent or establish how much memory its ancestors use. The user initially
reported no jitter, then reported its return without another change. The
spacer's smaller paint area is not an established jitter fix.

The user's most consistent observation is that a fresh load starts without
jitter. Subsequent behavior is intermittent. If investigation resumes, compare
the same unchanged document before and after onset. Do not treat a brief
improvement after a reload or edit as a successful patch. Further evidence would
need to distinguish changes in browser rendering state, graphics memory, input
delivery, and presentation timing. CSS inspection and regular page animation
callbacks cannot identify which of these changed.

## Reproduction and limits

The optional native-profiler setup is
`scripts/firefox-profile/fixtures/scroll-isolation.js`. It supports the original
normal, retained, and guarded-pause modes through `isolation-mode` in the URL.
It deliberately does not support complete removal: that mode also removes the
profiler's scroll observers and would invalidate its movement sampler.

No raw performance capture was produced in this round. Earlier quantitative
handler attribution remains in the [scroll audit](scroll-hot-path-2026-09-29.md).
The new browser regressions check mode mechanics and restoration; they do not
measure trackpad momentum or establish that physical presentation is smooth.

## Verification

Before committing, `pnpm run check` passes with two existing canvas-override
specificity warnings. All 5,623 unit tests and 184 portable profiling checks
pass. The listener-isolation regression passes in Firefox, Chromium, and WebKit,
covering removal, restoration, retained row identity, and boundary/resize
recovery. Its initial positioning now waits for the actual scroll event before
checking readiness, avoiding a race with native event delivery. Test browsers
are closed after their runs; the pre-existing demo server and regular browsers
are preserved.
