import { describe, expect, it } from "vitest";
import { FollowController } from "../../src/follow";

function setup() {
  const state = {
    end: 1000,
    lastTop: 800 as number | null,
    hidden: false,
    now: 0,
  };
  const follow = new FollowController({
    maxScrollTop: () => state.end,
    lastItemTop: () => state.lastTop,
    hidden: () => state.hidden,
    now: () => state.now,
  });
  return { state, follow };
}

describe("follow policy", () => {
  it("follows growth to the live end and ignores subpixel gaps", () => {
    const { state, follow } = setup();
    expect(follow.target(0)).toBe(1000);
    expect(follow.needsMotion(999.5)).toBe(false);
    state.end = 1200;
    expect(follow.target(1000)).toBe(1200);
    expect(follow.needsMotion(1000)).toBe(true);
  });

  it("keeps the reply start below its inset without moving backwards", () => {
    const { state, follow } = setup();
    follow.setMode("keep-start", 40);
    expect(follow.target(0)).toBe(760);
    expect(follow.atLimit(760)).toBe(true);
    expect(follow.target(900)).toBe(900);
    expect(follow.needsMotion(900)).toBe(false);
    state.lastTop = null;
    expect(follow.target(0)).toBe(1000);
  });

  it("keeps explicit viewport intent disarmed even at the end", () => {
    const { follow } = setup();
    follow.resolveCommit("auto", 1000);
    expect(follow.armed).toBe(true);
    follow.resolveCommit("viewport", 1000);
    expect(follow.armed).toBe(false);
    follow.resolveCommit("none", 1000);
    expect(follow.armed).toBe(false);
  });

  it("arms a settled end command after its target has grown", () => {
    const { follow } = setup();
    const state = {
      takingOver: false,
      atEnd: false,
      endCommand: true,
      gliding: false,
      position: 500,
    };
    expect(follow.resolveSettle(state)).toBe(true);
    expect(follow.armed).toBe(true);
    expect(follow.resolveSettle(state)).toBe(false);
    expect(follow.resolveSettle({ ...state, takingOver: true })).toBe(true);
    expect(follow.armed).toBe(false);
  });

  it("catches up instantly while hidden and for 300ms after resuming", () => {
    const { state, follow } = setup();
    expect(follow.catchingUp).toBe(false);
    state.hidden = true;
    expect(follow.catchingUp).toBe(true);
    state.hidden = false;
    state.now = 100;
    follow.resume();
    state.now = 399;
    expect(follow.catchingUp).toBe(true);
    state.now = 400;
    expect(follow.catchingUp).toBe(false);
  });
});
