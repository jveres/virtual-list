// Button-navigation diagnostic. Private inputs remain under browser-artifacts.
(() => {
  const source = new URLSearchParams(location.search).get("profile-transcript");
  if (!source?.startsWith("/browser-artifacts/"))
    throw new Error("Expected a local /browser-artifacts/ transcript");
  const viewport = document.querySelector("#viewport");
  const status = document.querySelector("#window-status");
  const marks = [];
  const mark = (phase) => {
    if (window.__ffProfile) {
      window.__ffProfile.phase = phase;
      window.__ffProfile.navigation = marks;
    }
    marks.push({
      phase,
      time: performance.now(),
      top: viewport.scrollTop,
      max: viewport.scrollHeight - viewport.clientHeight,
      range: status.textContent,
    });
    performance.mark(phase);
  };
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
  for (const [delay, phase, id] of [
    [12000, "first-top", "scroll-top-btn"],
    [18000, "second-top", "scroll-top-btn"],
    [24000, "bottom", "scroll-bottom-btn"],
  ]) {
    setTimeout(() => {
      mark(`${phase}-before`);
      document.querySelector(`#${id}`).click();
      mark(`${phase}-after-click`);
      setTimeout(() => mark(`${phase}-settled`), 2500);
    }, delay);
  }
  return { source, workload: "Two top clicks, then bottom; no wheel input" };
})();
