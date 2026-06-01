/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHarnesses,
  mountFullList,
} from "../helpers/virtual-list-harness";

// refreshFrom is the branch-switch primitive: rebuild the mounted tail at or
// after an index, leave the prefix untouched. "Untouched" means the very same
// DOM nodes — that's what lets a chat keep the messages above a switched version
// from repainting. renderMode "full" mounts every row regardless of layout, so
// the reuse-vs-rebuild contract is observable in jsdom without real geometry.

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start }, (_, i) => start + i);

const ascending = (values: number[]): number[] =>
  [...values].sort((a, b) => a - b);

afterEach(cleanupHarnesses);

describe("createVirtualList in full render mode", () => {
  it("should mount every item once on init", () => {
    const { builds, mountedElements } = mountFullList(6);
    expect(ascending(builds)).toEqual(range(0, 6));
    expect(mountedElements().every((element) => element !== null)).toBe(true);
  });
});

describe("refreshFrom", () => {
  it("should rebuild only the suffix and reuse the prefix by reference", () => {
    const harness = mountFullList(8);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;
    const destroysBefore = harness.destroys.length;

    harness.list.refreshFrom(5);

    const after = harness.mountedElements();
    const rebuilt = harness.builds.slice(buildsBefore);
    const destroyed = harness.destroys.slice(destroysBefore);

    // Prefix: same DOM nodes, never re-built or destroyed.
    for (const index of range(0, 5)) {
      expect(after[index]).toBe(before[index]);
    }
    // Suffix: fresh nodes, and the old ones were torn down.
    for (const index of range(5, 8)) {
      expect(after[index]).not.toBe(before[index]);
      expect(after[index]).not.toBeNull();
    }
    expect(ascending(rebuilt)).toEqual(range(5, 8));
    expect(ascending(destroyed)).toEqual(range(5, 8));
  });

  it("should be a no-op at or beyond the count", () => {
    const harness = mountFullList(5);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.list.refreshFrom(5);
    harness.list.refreshFrom(99);

    expect(harness.builds.length).toBe(buildsBefore);
    expect(harness.mountedElements()).toEqual(before);
  });

  it("should rebuild the whole list at index 0, matching refreshMounted", () => {
    const harness = mountFullList(4);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.list.refreshFrom(0);

    const rebuilt = harness.builds.slice(buildsBefore);
    expect(ascending(rebuilt)).toEqual(range(0, 4));
    for (const index of range(0, 4)) {
      expect(harness.mountedElements()[index]).not.toBe(before[index]);
    }
  });

  it("should rebuild every mounted row on refreshMounted", () => {
    const harness = mountFullList(4);
    const buildsBefore = harness.builds.length;

    harness.list.refreshMounted();

    const rebuilt = harness.builds.slice(buildsBefore);
    expect(ascending(rebuilt)).toEqual(range(0, 4));
  });

  it("should rebuild only the targeted row on refreshIndex", () => {
    const harness = mountFullList(5);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.list.refreshIndex(2);

    expect(ascending(harness.builds.slice(buildsBefore))).toEqual([2]);
    const after = harness.mountedElements();
    expect(after[2]).not.toBe(before[2]);
    for (const index of [0, 1, 3, 4]) {
      expect(after[index]).toBe(before[index]);
    }
  });
});
