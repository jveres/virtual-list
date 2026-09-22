// Import a local transcript, then leave the runner's native wheel gestures
// as the only input. Private inputs remain under browser-artifacts.
(() => {
  const source = new URLSearchParams(location.search).get("profile-transcript");
  if (!source?.startsWith("/browser-artifacts/"))
    throw new Error(
      "profile-transcript must name a local /browser-artifacts/ file",
    );
  window.confirm = () => true;
  const started = performance.now();
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
      performance.mark("transcript-imported");
      if (window.__ffProfile)
        window.__ffProfile.importMs = performance.now() - started;
    });
  return {
    source,
    workload: "local transcript import, then native wheel only",
  };
})();
