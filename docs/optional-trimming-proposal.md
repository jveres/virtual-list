# Optional trimming and offscreen pins

Implement optional pager trimming and one runtime flag that permits eviction of
an offscreen pin. Keep existing retention behavior by default. This design
addresses SI-02 in the [streaming integration plan](streaming-integration-plan.md).
The user approved this design on September 13, 2026. The branch now includes
the runtime flag, pager modes, and consumer/demo integration. Verification
is in progress; this document is not a performance result or release approval.

## Why existing composition is insufficient

`updateWindow` includes the persistent pin in `protectedItems`, even when it
is outside the visible and overscan window. The pager preserves protected
source items and evicts only whole pages from a contiguous window's ends.
When you read older history, a pin in the latest page can therefore prevent
eviction of that page and every intervening page.

`pinning: false` avoids that retention but removes prompt-pinning behavior.
Having the pager ignore protected items cannot distinguish a pin from a
visible row or a pending explicit target. Using `setItems` instead bypasses
the pager's idle transaction and staged-preparation safeguards.

The same case occurs in a live event viewer: pin the current event while
following, but allow its page to leave memory when reading older events.

## Public surface

Keep the budget and eviction policy in the optional paging companion. Add
this option to `PagedWindowOptions`:

```ts
trim?: false | { offscreenPin?: "retain" | "evict" };
```

Omission preserves today's behavior: automatic whole-page trimming toward
`maxItems`, with the pin protected. The modes have these meanings:

- `trim: false` disables budget-driven eviction. `maxItems` is inactive in
  this mode, and `reconcile()` returns `null` without scheduling trim work.
  Explicit source replacement and disposal still release old data.
- `trim: { offscreenPin: "retain" }` is the default policy, also selected by
  `trim: {}`. The retained window can exceed its budget to preserve the pin.
- `trim: { offscreenPin: "evict" }` permits budget-driven eviction of the
  pinned page only when the pin is outside the visible and overscan window
  and is not an explicit navigation target.

The existing third argument of runtime `updateWindow` accepts one new flag:

```ts
list.updateWindow(update, signal, {
  interrupt: false,
  protectPin: false, // default: true
});
```

`protectPin: false` removes only the pin's extra protection. It does not
remove visible, overscan, or explicit-target protection, select pages,
enforce a budget, or change gesture scheduling. The pager supplies this flag
only for trimming transactions using the offscreen-eviction policy. No new
scroll controller, pin command, retention callback, or per-frame scan is
introduced.

## Commit and restoration contract

Trimming remains an idle, anchor-preserving window transaction. The design
must meet these requirements before the option ships:

1. Preserve visible and overscan rows and pending explicit targets. Protect
   an explicit target returned by the updater as well. For the new opt-in
   path, reject a snapshot that omits those required keys, including when
   preparation completes synchronously.
2. Re-evaluate protection before a staged commit. If movement makes a
   proposed eviction unsafe, cancel uncommitted work with `false`; do not
   partially evict. A later pager reconciliation can retry after settle.
3. Remove an evicted pin and adjust its trailing reserve in the same
   geometry commit. Preserve the reader's viewport anchor. Do not perform
   demo-side scroll correction.
4. Keep `maxItems` a soft budget: protected rows, page boundaries, or one
   oversized page may legitimately keep the window above it. Disabling pin
   protection is not a hard-memory-cap guarantee.
5. Notify `onEvict` only for committed source eviction. Keep cancellation,
   disposal, and render-failure semantics consistent with the existing
   pager. A cancelled proposal must not change source ownership.

For streaming chat, identify the latest prompt in the application-owned
conversation, not by selecting the last user row in the retained window:

```ts
pinning: {
  match: (message) => message.id === latestPromptId,
}
```

With that existing declarative API, an absent prompt means no pin. Reloading
its page restores the matching pin and offset during snapshot commit. The
runtime must not substitute an older prompt, jump to the restored pin, or
rearm following merely because the page returned. The existing explicit
scroll-to-end action expresses follow intent after the tail is loaded.

This proposal does not add automatic restoration for imperative pins created
by scroll commands. Those callers must use declarative matching or explicitly
establish a new pin through the existing command API. The runtime does not
retain evicted message objects just to remember a pin.

The host keeps authoritative stream text in its source while the reply is
evicted. A live update for an absent row does not recreate that row; reloading
its page must obtain current text from the source. Conversation replacement
must cancel old paging and streaming work before constructing new ownership.

## Acceptance tests and implementation sequence

Design approval is recorded above. Track the work as SI-02a through SI-02d
under SI-02. Implementation is uncommitted; completion requires the release
plan's evidence and commit references.

- [ ] **SI-02a — Runtime contract:** Test unchanged default pin protection,
  offscreen eligibility, visible/overscan pins, explicit targets, synchronous
  validation, and cancellation when a staged eviction becomes unsafe.
- [ ] **SI-02b — Optional pager trimming:** Test all three policies, both
  eviction directions, whole-page soft budgets, overlap ownership, source
  notifications, live-update races, and disposal.
- [ ] **SI-02c — Consumer and demo integration:** Test history traversal with
  an active latest-prompt pin, eviction during streaming, source restoration,
  no older-prompt substitution, reserve removal/restoration, explicit end
  rearm, and branch/conversation reset. Migrate the full demo only after the
  standalone consumer passes.
- [ ] **SI-02d — Release evidence:** Run unit/type checks and browser
  regressions, then capture comparable native Firefox baseline and repeat
  evidence for the changed workload. Keep raw profiles local and record
  remaining limitations in the release plan.

The core change is limited to `updateWindow`'s `protectPin` flag. The pager
owns budget and eviction policy. Complete SI-02d before treating the changed
demo as release-ready.
