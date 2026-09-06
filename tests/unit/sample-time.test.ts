import { describe, expect, it } from "vitest";
import { sampleTimestamp } from "../../demos/streaming/sample-time";

describe("sample timestamps", () => {
  it.each([
    [2026, 8, 6],
    [2026, 0, 1],
    [2026, 2, 30],
    [2026, 9, 26],
  ])(
    "should end on the previous local calendar day for %i/%i/%i",
    (year, month, day) => {
      const now = new Date(year, month, day, 0, 15).getTime();
      const expected = new Date(year, month, day - 1, 12, 10);

      const last = sampleTimestamp(101, 101, now);

      expect(last).toBe(expected.getTime());
    },
  );

  it("should keep sample messages ordered in eight-message calendar groups", () => {
    const now = new Date(2026, 8, 6, 17).getTime();
    const times = Array.from({ length: 102 }, (_, index) =>
      sampleTimestamp(index, 101, now),
    );

    expect(
      times.every(
        (time, index) => index === 0 || time > (times[index - 1] ?? 0),
      ),
    ).toBe(true);
    expect(new Date(times[95] ?? 0).getDate()).toBe(4);
    expect(new Date(times[96] ?? 0).getDate()).toBe(5);
    expect(new Date(times[101] ?? 0).getDate()).toBe(5);
  });
});
