# Safari paging blocked by a consumed edge trigger

A fresh top/bottom command now rearms its edge trigger if no load is pending.
This fixes a reproducible navigation handoff that left the viewport at zero,
with older messages available and no active load. Ordinary scrolling keeps its
existing proximity hysteresis. The changes remain a local testing candidate.

## Live-page evidence

The user reported the failure after the top button in the already-open desktop
Safari page. Inspection preserved the page rather than reloading it. Safari
27.0 reported a 1920 × 959 inner window at DPR 2; the chat viewport was 810
pixels tall. This was a WebKit correctness investigation, not a performance
comparison or an iOS momentum measurement.

The page showed `loaded 49-104/104`, `scrollTop: 0`, a scroll height of 25,691,
and an idle top slot. The slot had not been removed from layout; its loading
indicator had cleared. Row 49 was the first mounted message. A temporary
observer of the existing reach controller found `armed.start === false`, zero
pending start/end signals, and `disposed === false`. A scroll event without
movement did not trigger a load.

One controlled rearm at the unchanged position loaded messages 25–72 and wrote
the expected anchor position, 10,647. A subsequent top-button command loaded
messages 1–72 and preserved its anchor at 9,910. This confirms that data and
the pager were available, and that the consumed trigger blocked further work.
The original event sequence was not recorded, so its initial cause cannot be
reconstructed from this snapshot alone.

## Deterministic matching failure

An isolated regression first loads enough older history to evict the tail,
then presses bottom. Restoring that tail positions its first retained row near
the top before starting the final native bottom animation. A proximity callback
can run during this intermediate state while `windowNavigation` is still busy.
The demo skips loading and completes the reach signal. Completion releases the
signal but leaves the edge disarmed.

Pressing top at the first native bottom-animation request reproduces the dead
end: `loaded 73-102/102`, `scrollTop: 0`, and an idle loader, with no page progress.
The ordinary 0/16/50/100/200/350 ms takeover controls had passed; targeting this
specific handoff makes the failure deterministic. This reproduces the same
stuck mechanism as the user's page, but does not prove their preceding actions
followed this exact sequence.

The root mismatch is that proximity hysteresis was also treating an explicit
new edge command as an already-consumed request. It required moving more than
1,200 pixels away before another load could begin.

## Candidate and validation

`ReachController.request(edge)` rearms only when the controller is live and no
signal remains pending for that edge. The runtime calls it for explicit
`scrollTo("start")` and `scrollTo("end")` commands after taking over existing
motion. Completion alone still does not rearm, and a command cannot overlap an
active load. No automatic retry timer or background fetching loop is added.

The targeted WebKit failure now advances to messages 49–102 with scroll position
10,776, preserving access to the prepended page. The reusable regression also
checks earlier/later takeovers and asserts completed page progress, rather than
treating a visible loader as success:

```sh
pnpm run test:regression -- --match=chat-reach-takeover
```

Related local chat fixes preserve existing simulated tool panels when a thinking
reply starts streaming. The viewer's default autofocus caused the reported
large outline and could move the viewport; the chat now sets
`focusOnStreamingStart: false`. Keyboard focus styling remains available when
the user deliberately focuses the viewer.

Verification passed: `pnpm run check`, all 1,081 unit tests, and all 12 paging
takeover cases across Firefox, Chromium, and WebKit. Tool-panel identity and
autofocus, answer-follow limits, touch-paging edges, bottom loaders, and tree
bottom navigation also passed their browser regressions. These are automated
correctness checks, not measurements of physical presentation smoothness.

The tree bottom-navigation regression initially sampled the old window's end
before tail restoration finished. Its completion check now requires the loaded
range to include the actual transcript end, no active loader, and the viewport
at the bottom. The corrected regression passes in all three engines.

## Native-only animation cleanup

After the native-scroll testing candidate, the custom easing engine had no
browser callers. It remained only as a fallback for viewports without
`scrollTo`, including the jsdom harness. The engine, pacing helpers, redundant
landing-phase flag, and custom-animation profiler records are now removed.
The harness supplies asynchronous scroll movement and events instead.

Programmatic navigation and following still exist, with native smooth
animation. Direct writes still preserve anchors, restore positions, and handle
instant commands or visibility catch-up. The public `duration` field remains
deprecated and ignored for source compatibility.

The cleanup passes `pnpm run check`, 1,056 unit tests, and 127 portable profiler
checks. The 25 removed unit cases covered the deleted easing engine; native
completion, cancellation, and runtime contract coverage remain. Browser
regressions cover native navigation, answer-follow limits, and paging takeover
in Firefox, Chromium, and WebKit. This is code cleanup, not a new performance
claim.

Compact live-state findings and source reproduction metadata remain under
ignored `browser-artifacts/safari-paging-live/`. Temporary live hooks expired
and restored the original methods. Raw diagnostic records and temporary scripts
are removed after analysis. No private message text was retained.
