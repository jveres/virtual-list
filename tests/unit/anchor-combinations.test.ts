import { expect, it } from "vitest";
import { replacementAnchor } from "../../src/companions/reading-anchor";
import { Geometry } from "../../src/geometry";

const cases: {
  viewport: number;
  inset: number;
  height: number;
  reply: number;
  offset: number;
  nextHeight: number;
  replace: boolean;
  pin: boolean;
}[] = [];
for (const viewport of [320, 813, 1000])
  for (const inset of [0, 40])
    for (const height of [100, 220, 540])
      for (const reply of [100, 386, 900])
        for (const offset of [-500, -24, 0, 30, 39.5, 200])
          for (const nextHeight of [80, 148, 220, 540])
            for (const replace of [false, true])
              for (const pin of [false, true])
                if (offset < viewport && offset + height > inset)
                  cases.push({
                    viewport,
                    inset,
                    height,
                    reply,
                    offset,
                    nextHeight,
                    replace,
                    pin,
                  });

it.each(cases)(
  "preserves/reveals and releases reserve: %j",
  ({ viewport, inset, height, reply, offset, nextHeight, replace, pin }) => {
    const geometry = new Geometry(100);
    const prefix = Array.from({ length: 10 }, (_, index) => String(index));
    geometry.setKeys([...prefix, "prompt", "reply"]);
    geometry.measure("prompt", height);
    geometry.measure("reply", reply);
    if (pin) geometry.pin("prompt", inset);
    const start = geometry.resolve(
      geometry.capture({ scrollTop: 0, height: viewport }, "viewport", {
        key: "prompt",
        offset,
      }),
    );
    const list = {
      positionOf: (key: string) => ({
        top: geometry.offsetOf(key),
        height: geometry.heightOf(key),
      }),
      get state() {
        return { totalSize: geometry.totalSize };
      },
    };
    const key = replace ? "replacement" : "prompt";
    const anchor = replacementAnchor(
      list,
      { scrollTop: start.scrollTop, clientHeight: viewport },
      [{ from: "prompt", to: key }],
      inset,
    );
    expect(anchor).toBeDefined();
    const captured = geometry.capture(
      { scrollTop: start.scrollTop, height: viewport },
      "viewport",
      anchor,
    );
    geometry.setKeys([...prefix, key, "reply"], anchor);
    geometry.measure(key, nextHeight);
    const result = geometry.resolve(captured);

    const normalized = Math.abs(offset - inset) < 1 ? inset : offset;
    const expected = normalized + nextHeight <= inset ? inset : normalized;
    expect(geometry.offsetOf(key) - result.scrollTop).toBe(expected);
    const settled = geometry.resolve(
      geometry.capture(
        { scrollTop: result.scrollTop, height: viewport },
        "viewport",
      ),
    );
    expect(settled.scrollTop).toBe(result.scrollTop);
    // Moving away releases reading-only reserve, while retaining the actual pin.
    const away = geometry.resolve(
      geometry.capture({ scrollTop: 0, height: viewport }, "none"),
    );
    const end = Math.max(
      0,
      geometry.contentSize - viewport,
      pin ? 1000 - inset : 0,
    );
    expect(away.scrollTop).toBe(0);
    expect(geometry.maxScrollTop(viewport)).toBe(end);
  },
);
