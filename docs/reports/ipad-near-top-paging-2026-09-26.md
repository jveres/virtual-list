# iPad near-top paging investigation

The local candidate holds changes above the reading position until a WebKit
touch gesture and its momentum have settled. Preparation can continue in idle
callbacks. The final commit preserves the reading position with an explicit
scroll write. Native flow and native smooth button navigation remain enabled.
The user could not reproduce the failure during the captured real-swipe run.
Additional controlled edge cases exposed two paging stalls and a skipped
history range, now corrected.

## Evidence and limits

This is a WebKit-specific correctness investigation, an exception to the
Firefox-first performance workflow. The connected device runs iPadOS 27.0 and
Safari 27.0. Its inspected viewport is 1180 × 734 CSS pixels at DPR 2; the
chat scroller is 585 pixels tall. The retained simulated conversation contains
110 messages.

A controlled check on the long-lived page dispatched synthetic touch events
and moved to 30 pixels from the top, leaving part of the 52-pixel loading slot
visible. The loaded range advanced from 85–110 to 61–110 and scroll height grew
from 12,395 to 22,305 pixels. Scroll position stayed at 30 instead of advancing
with the prepend. Moving upward then reached zero; the start proximity trigger
had not been rearmed because the viewport never left its exit zone.

This demonstrates an anchor adjustment being lost in that page state. It does
not establish why Safari lost it, or prove that it is the same failure as the
reported real swipe. Fresh isolated chat instances preserved the anchor. In
the matching-size fresh control, message 85 stayed 62 pixels below the viewport
top and scroll position advanced to 9,940. Basic native anchoring and an
isolated virtual list also passed. The temporary isolation probes were removed
after this comparison; their source is retained in the ignored replay patches.

The first passive captures contained no input and are invalid as swipe
evidence. The subsequent user-assisted capture recorded 38 trusted touch starts,
3,961 scroll events, and 24 successful window updates, with no failed updates
or dropped records. Loaded starts repeatedly advanced through
85 → 61 → 37 → 13 → 1. Real near-top stops at 11 and 220 pixels committed
after settle, moving to 11,119 and 5,337 pixels respectively. Re-grabs,
rubber-banding, and top/bottom navigation also appear in the trace. This is
successful device correctness evidence; it does not establish the original
Safari suppression trigger or measure physical presentation smoothness.

The compact capture and source replay are under the ignored directory
`browser-artifacts/ipad-scroll/run-xp44gW/`.

## Candidate and regression coverage

The previous native fast path considered only proximity to an edge and an
active programmatic glide. Being 30 pixels from the top permitted a prepend
during touch scrolling. The candidate additionally keeps WebKit touch phases
behind the settle gate. Touch ownership survives finger release and clears
when the whole scroll phase settles. Wheel input retains its existing policy.

Two runtime regressions exercise `setItems` and staged `updateWindow` prepends
with native anchoring unavailable in the test environment. Both fail against
the previous revision because the page commits while the touch is still held.
With the candidate, the existing window remains intact through held touch and
continued momentum. After settle, 24 rows prepend and the reading offset is
preserved by the runtime write. A controller regression verifies that touch
ownership clears before a later wheel phase.

The browser regression now includes 30-pixel near-top loads at 390 × 844 and
1180 × 734, alongside the existing exact-top phone and tablet cases. These
synthetic checks verify page reachability, not native momentum or physical
presentation smoothness.

The tablet case deliberately suppresses native anchoring after the runtime
selects native flow. It holds the touch long enough for preparation to finish.
Against the previous revision, the reading position stays at 30 pixels after
the prepend. The candidate preserves the position and reaches every older
page. This isolates the failure of relying on a native adjustment without
asserting why Safari declined that adjustment on the long-lived page.

## Further edge cases

The user requested more edge cases after the successful manual run. Controlled
WebKit checks reproduced three additional failures:

- A width change during staged row creation canceled the window update. The
  demo hid the loader at position 30 while retaining the old loaded range.
  `updateWindow` now discards stale prepared rows, re-evaluates its updater at
  the new width, and completes the pending update. It still honors aborts,
  disposal, and superseding source changes.
- If the last scroll happened with a finger held and no `scrollend` followed
  release, the fallback timer had never been armed. The loader remained
  indefinitely. Touch release now starts the existing quiet fallback, with
  its momentum, rubber-band, and Firefox edge protections intact.
- Rotating from portrait to landscape between loads reduced the page size
  from 36 to 24. The old cursor skipped 12 messages; status changed from
  61–102 to 25–90 even though the retained tail still ended at 102. A start
  cursor now identifies the retained history boundary. The previous page
  always ends at that boundary, regardless of its newly calculated size.

Re-grabbing during momentum, reversing direction before commit, and a bottom
command during a pending top load passed. All six cases pass after these
corrections in `chat-touch-paging-edges-regression.mjs`; the rotation case also
runs in Firefox and Chromium. Unit coverage also
checks restaging from an idle callback and abort during stale-row cleanup.

Temporary isolation probes and checkouts were removed. Rebuildable Swift
profiling caches were also removed, freeing about 412 MB. Compact reports and
source replay metadata remain; no raw device trace is retained.

## Reproduction

Use the default simulated conversation. Swipe toward older messages until the
loader becomes visible, stop short of the exact top, and allow loading and
momentum to finish. Confirm that older rows become reachable and that another
upward traversal can load the next page. Leave a stuck page in place for
inspection.

With a local iOS bridge already connected and no other debugger attached:

```sh
node scripts/firefox-profile/ipad-scroll-trace.mjs \
  ws://127.0.0.1:9222/devtools/page/PAGE_ID --state --seconds 900
```

The optional duration allows time to reproduce an intermittent failure. It
defaults to 180 seconds and is limited to 1,800 seconds. Stop early with Ctrl-C.
Reloading the page ends this capture; start a new capture after the reload.
Compact summaries retain touch/release and paging transitions, a count of
trusted touch starts, aggregate motion, source hashes, and a replay patch.
Per-frame records stay in memory and are discarded during cleanup.

Run the automated correctness checks with:

```sh
pnpm run check
pnpm test
pnpm run test:firefox-profile
pnpm run test:regression --group=chat-scrolling
```

The final verification includes 1,060 passing unit tests and 125 portable
profiler checks. The complete chat-scrolling group passed after the touch
gate change. After the additional fixes, focused browser checks cover native
anchoring, dynamic resize, live-stream paging, paged consumer restoration,
gallery resize, ordinary touch paging, and the edge cases above.
