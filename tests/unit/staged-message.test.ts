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

function tableFixture(prelude = 0, tableCount = 1) {
  const row = document.createElement("article");
  row.innerHTML = `<div class="message-content"><div class="markdown-viewer"><div class="markdown">${"<p>Before</p>".repeat(prelude)}${Array.from({ length: tableCount }, (_, table) => `<div class="table-wrapper"><table><thead><tr><th>Value</th></tr></thead><tbody>${Array.from({ length: 1000 }, (_, index) => `<tr><td>${table}:${index}</td></tr>\n`).join("")}</tbody></table></div>`).join("")}<p>After</p></div></div></div>`;
  return {
    row,
    bodies: Array.from(row.querySelectorAll("tbody")),
    nodes: Array.from(row.querySelectorAll("*")),
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

  it("should spread large tables across steps and preserve their content and listeners", () => {
    const { row, bodies, nodes, html } = tableFixture(20, 2);
    const cell = row.querySelector("td");
    if (!cell) throw new Error("Expected table cell");
    let clicks = 0;
    cell.addEventListener("click", () => clicks++);

    const staged = stageMessageLayout(row);
    if (!staged) throw new Error("Expected staged table");
    expect(staged.next().done).toBe(false);
    expect(bodies.map((body) => body.rows.length)).toEqual([0, 0]);
    expect(staged.next().done).toBe(false);
    expect(row.contains(bodies[0] ?? null)).toBe(true);
    expect(bodies[0]?.rows.length).toBeGreaterThan(0);
    expect(bodies[0]?.rows.length).toBeLessThan(1000);
    expect(bodies[1]?.rows.length).toBe(0);
    let steps = 2;
    while (!staged.next().done && steps < 100) steps++;

    expect(steps).toBeLessThan(100);
    expect(row.innerHTML).toBe(html);
    const restored = Array.from(row.querySelectorAll("*"));
    expect(restored.length).toBe(nodes.length);
    for (const [index, node] of restored.entries())
      expect(node).toBe(nodes[index]);
    cell.click();
    expect(clicks).toBe(1);
  });

  it.each([0, 1, 3])(
    "should restore complete tables when cancelled after %i steps",
    (steps) => {
      const { row, nodes, html } = tableFixture(0, 2);
      const staged = stageMessageLayout(row);
      if (!staged) throw new Error("Expected staged table");
      for (let index = 0; index < steps; index++) staged.next();

      expect(staged.return?.().done).toBe(true);
      expect(staged.next().done).toBe(true);
      expect(row.innerHTML).toBe(html);
      const restored = Array.from(row.querySelectorAll("*"));
      expect(restored.length).toBe(nodes.length);
      for (const [index, node] of restored.entries())
        expect(node).toBe(nodes[index]);
    },
  );

  it("should leave an ordinary table intact without staging", () => {
    const { row, bodies } = tableFixture();
    const body = bodies[0];
    if (!body) throw new Error("Expected table body");
    while (body.rows.length > 100) body.lastElementChild?.remove();
    const html = row.innerHTML;
    const first = body.firstElementChild;

    expect(stageMessageLayout(row)).toBeUndefined();
    expect(row.innerHTML).toBe(html);
    expect(body.firstElementChild).toBe(first);
  });
});
