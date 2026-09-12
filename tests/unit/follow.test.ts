import { describe, expect, it } from "vitest";
import { FollowController } from "../../src/follow";

function setup() {
  const state = {
    end: 1000,
    lastTop: 800 as number | null,
    lastKey: "reply" as string | null,
    hidden: false,
    now: 0,
  };
  const follow = new FollowController({
    maxScrollTop: () => state.end,
    lastItemTop: () => state.lastTop,
    lastItemKey: () => state.lastKey,
    hidden: () => state.hidden,
    now: () => state.now,
  });
  return { state, follow };
}

describe("follow policy", () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -20,
  ])("should use a zero inset for invalid configuration (%s)", (inset) => {
    const follow = new FollowController(
      {
        maxScrollTop: () => 1000,
        lastItemTop: () => 800,
        lastItemKey: () => "reply",
        hidden: () => false,
        now: () => 0,
      },
      "keep-start",
      inset,
    );

    expect(follow.target(0)).toBe(800);
    expect(follow.needsMotion(0)).toBe(true);
    follow.setMode("keep-start", 40);
    expect(follow.target(0)).toBe(760);
    follow.setMode("keep-start", inset);
    expect(follow.target(0)).toBe(800);
    expect(follow.needsMotion(0)).toBe(true);
  });

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

  it("should override keep-start for resumed growth without changing the configured mode", () => {
    const { state, follow } = setup();
    follow.setMode("keep-start", 40);

    follow.resolveSettle({
      takingOver: false,
      atEnd: true,
      endCommand: true,
      gliding: false,
      position: 1000,
    });
    state.end = 1200;
    follow.resolveCommit("auto", follow.target(1000));

    expect(follow.target(1000)).toBe(1200);
    expect(follow.needsMotion(1000)).toBe(true);
    expect(follow.armed).toBe(true);
    expect(follow.atLimit(760)).toBe(false);
    state.lastTop = 1400;
    state.lastKey = "next-reply";
    state.end = 2000;
    expect(follow.target(1200)).toBe(1360);
    expect(follow.atLimit(1360)).toBe(true);
  });

  it("should retain the override when the same reply moves and its inset changes", () => {
    const { state, follow } = setup();
    follow.setMode("keep-start", 40);
    follow.start();

    state.lastTop = 900;
    state.end = 1300;
    follow.setMode("keep-start", 60);

    expect(follow.target(1000)).toBe(1300);
    expect(follow.armed).toBe(true);
  });

  it("should clear the end override when user input stops following", () => {
    const { state, follow } = setup();
    follow.setMode("keep-start", 40);
    follow.start();

    follow.stop();
    state.end = 1200;

    expect(follow.armed).toBe(false);
    expect(follow.target(900)).toBe(900);
    expect(follow.needsMotion(900)).toBe(false);
  });

  it.each(["viewport", "none"] as const)(
    "should clear the override when a %s commit claims the viewport",
    (policy) => {
      const { follow } = setup();
      follow.setMode("keep-start", 40);
      follow.start();

      follow.resolveCommit(policy, 1000);

      expect(follow.armed).toBe(false);
      expect(follow.target(900)).toBe(900);
    },
  );

  it("should honor a mode change after an end override", () => {
    const { follow } = setup();
    follow.setMode("keep-start", 40);
    follow.start();

    follow.setMode("end");
    follow.setMode("keep-start", 40);

    expect(follow.target(0)).toBe(760);
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
