// Diagnostic workload: local transcript import, then two Scroll to top clicks.
// Geometry reads occur only in mutation callbacks, never in the rAF sampler.
(() => {
  const source = new URLSearchParams(location.search).get("profile-transcript");
  if (!source?.startsWith("/browser-artifacts/"))
    throw new Error(
      "profile-transcript must name a local /browser-artifacts/ file",
    );
  window.confirm = () => true;
  fetch(source)
    .then((response) => {
      if (!response.ok) throw new Error(`Transcript fetch: ${response.status}`);
      return response.text();
    })
    .then((markdown) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([markdown], "local-transcript.md", { type: "text/markdown" }),
      );
      const input = document.querySelector("#import-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  setTimeout(() => {
    const viewport = document.querySelector("#viewport");
    let lastTop = viewport.scrollTop;
    viewport.addEventListener(
      "scroll",
      () => {
        lastTop = viewport.scrollTop;
      },
      { capture: true },
    );
    new MutationObserver((records) => {
      const changed = new Map();
      for (const record of records) {
        if (
          changed.has(record.target) ||
          record.target.parentElement !== viewport.firstElementChild
        )
          continue;
        const before = /transform:\s*translateY\(([-\d.]+)px\)/.exec(
          record.oldValue ?? "",
        );
        const after = /translateY\(([-\d.]+)px\)/.exec(
          record.target.style.transform,
        );
        if (before && after && before[1] !== after[1])
          changed.set(record.target, Number(after[1]) - Number(before[1]));
      }
      const top = viewport.scrollTop;
      for (const [slot, delta] of changed) {
        const row = slot.querySelector(".message");
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        if (rect.bottom <= bounds.top + 44 || rect.top >= bounds.bottom)
          continue;
        if (window.__ffProfile) {
          window.__ffProfile.anchors ??= [];
          window.__ffProfile.anchors.push({
            key: row.dataset.key,
            delta,
            scrollDelta: top - lastTop,
            shift: delta - (top - lastTop),
            phase: window.__ffProfile.phase,
            range: document.querySelector("#window-status").textContent,
          });
        }
        break;
      }
      lastTop = top;
    }).observe(viewport.firstElementChild, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
      attributeOldValue: true,
    });
  }, 5000);
  setTimeout(() => document.querySelector("#scroll-top-btn").click(), 12000);
  setTimeout(() => document.querySelector("#scroll-top-btn").click(), 18000);
  return {
    source,
    workload: "Two Scroll to top button clicks; no wheel gestures",
  };
})();
