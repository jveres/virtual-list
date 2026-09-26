// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stageMessageLayout } from "../../demos/streaming/staged-message.js";

function fixture() {
  const row = document.createElement("article");
  row.innerHTML = `<div class="message-content"><div class="markdown-viewer"><div class="markdown"></div></div><div class="tool-calls">Tool</div><div class="markdown-viewer"><div class="markdown"></div></div></div>`;
  const hosts = Array.from(row.querySelectorAll<HTMLElement>(".markdown"));
  for (const host of hosts) {
    for (let index = 0; index < 24; index++) {
      const block = document.createElement("p");
      block.textContent = `Block ${index}`;
      host.append(block, document.createTextNode("\n"));
    }
  }
  return {
    row,
    hosts,
    nodes: hosts.map((host) => Array.from(host.childNodes)),
    html: row.innerHTML,
  };
}

describe("staged message layout", () => {
  it("should retain node identity, whitespace, and segment order across bounded steps", () => {
    const { row, hosts, nodes, html } = fixture();
    const staged = stageMessageLayout(row);
    if (!staged) throw new Error("Expected staged reply");
    expect(hosts.map((host) => host.childElementCount)).toEqual([0, 0]);
    expect(staged.next().done).toBe(false);
    expect(hosts.map((host) => host.childElementCount)).toEqual([16, 0]);
    expect(staged.next().done).toBe(false);
    expect(hosts.map((host) => host.childElementCount)).toEqual([24, 8]);
    // The last block's trailing whitespace can require one final cheap step.
    expect(staged.next().done).toBe(false);
    expect(staged.next().done).toBe(true);
    expect(row.innerHTML).toBe(html);
    for (const [index, host] of hosts.entries())
      for (const [offset, node] of Array.from(host.childNodes).entries())
        expect(node).toBe(nodes[index]?.[offset]);
  });

  it.each([0, 1])(
    "should restore withheld content when cancelled after %i steps",
    (steps) => {
      const { row, html } = fixture();
      const staged = stageMessageLayout(row);
      for (let index = 0; index < steps; index++) staged?.next();
      expect(staged?.return?.().done).toBe(true);
      expect(row.innerHTML).toBe(html);
      expect(staged?.next().done).toBe(true);
    },
  );

  it("should leave small replies untouched", () => {
    const row = document.createElement("article");
    row.innerHTML =
      '<div class="message-content"><div class="markdown-viewer"><div class="markdown"><p>Short reply</p></div></div></div>';
    const before = row.innerHTML;
    expect(stageMessageLayout(row)).toBeUndefined();
    expect(row.innerHTML).toBe(before);
  });
});
