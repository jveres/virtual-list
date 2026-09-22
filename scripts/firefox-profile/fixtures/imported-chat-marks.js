// Manual capture: import a local transcript, then record a mark each time
// the tester presses "j" (jitter noticed). Marks land in frames.json.marks.
// Private inputs remain under browser-artifacts.
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
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "j" || !window.__ffProfile) return;
      event.preventDefault();
      const viewport = document.querySelector("#viewport");
      window.__ffProfile.marks ??= [];
      window.__ffProfile.marks.push({
        time: performance.now(),
        top: viewport.scrollTop,
      });
      performance.mark("jitter-noticed");
    },
    true,
  );
  return {
    source,
    workload: "manual trackpad; press j when jitter is noticed",
  };
})();
