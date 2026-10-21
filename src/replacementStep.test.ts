import { describe, expect, test } from "bun:test";

import {
  nextReplacementStep,
  recoverFleet,
  replacementLimits,
} from "./replacementStep";

describe("replacementLimits", () => {
  test("110 on 6 and 4 instances is exactly one extra box", () => {
    expect(replacementLimits(6, 100, 110)).toEqual({
      target: 6,
      maxTotal: 7,
      minAlive: 6,
    });
    expect(replacementLimits(4, 100, 110)).toEqual({
      target: 4,
      maxTotal: 5,
      minAlive: 4,
    });
  });

  test("200 still allows a full second fleet", () => {
    expect(replacementLimits(6, 100, 200).maxTotal).toBe(12);
  });

  test("50/100 on two instances replaces in place", () => {
    expect(replacementLimits(2, 50, 100)).toEqual({
      target: 2,
      maxTotal: 2,
      minAlive: 1,
    });
  });

  test("0/100 on one instance allows a gap instead of a second box", () => {
    expect(replacementLimits(1, 0, 100)).toEqual({
      target: 1,
      maxTotal: 1,
      minAlive: 0,
    });
  });
});

describe("nextReplacementStep", () => {
  test("api roll adds one, then retires one, and never passes 7 or drops below 6", () => {
    const limits = replacementLimits(6, 100, 110);
    let oldDesired = 6;
    let newDesired = 0;
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const step = nextReplacementStep({ oldDesired, newDesired }, limits);
      seen.push(
        step.kind === "done"
          ? "done"
          : `${step.kind}:${step.kind === "stuck" ? 0 : step.count}`
      );
      if (step.kind === "done" || step.kind === "stuck") break;
      if (step.kind === "launch") newDesired += step.count;
      if (step.kind === "retire") oldDesired -= step.count;
      expect(oldDesired + newDesired).toBeLessThanOrEqual(limits.maxTotal);
      expect(oldDesired + newDesired).toBeGreaterThanOrEqual(limits.minAlive);
    }
    expect(seen).toEqual([
      "launch:1",
      "retire:1",
      "launch:1",
      "retire:1",
      "launch:1",
      "retire:1",
      "launch:1",
      "retire:1",
      "launch:1",
      "retire:1",
      "launch:1",
      "retire:1",
      "done",
    ]);
    expect(newDesired).toBe(6);
    expect(oldDesired).toBe(0);
  });

  test("200 launches the whole new fleet before retiring the old one", () => {
    const limits = replacementLimits(6, 100, 200);
    expect(
      nextReplacementStep({ oldDesired: 6, newDesired: 0 }, limits)
    ).toEqual({
      kind: "launch",
      count: 6,
    });
    expect(
      nextReplacementStep({ oldDesired: 6, newDesired: 6 }, limits)
    ).toEqual({
      kind: "retire",
      count: 6,
    });
  });
});

describe("recoverFleet", () => {
  test("a crashed roll keeps the older fleet and deletes the partial one", () => {
    const recovery = recoverFleet(
      [
        { name: "old", createdAt: 1, desired: 5, minSize: 0, maxSize: 6 },
        { name: "partial", createdAt: 2, desired: 1, minSize: 0, maxSize: 6 },
      ],
      6
    );
    expect(recovery).toEqual({
      canonicalName: "old",
      deleteNames: ["partial"],
      desired: 6,
      minSize: 6,
      maxSize: 6,
    });
  });

  test("an empty newer ASG is not treated as the fleet", () => {
    const recovery = recoverFleet(
      [
        { name: "old", createdAt: 1, desired: 6, minSize: 0, maxSize: 6 },
        { name: "empty", createdAt: 2, desired: 0, minSize: 0, maxSize: 6 },
      ],
      6
    );
    expect(recovery.canonicalName).toBe("old");
    expect(recovery.deleteNames).toEqual(["empty"]);
    expect(recovery.desired).toBe(6);
    expect(recovery.minSize).toBe(6);
  });

  test("a finished new fleet is kept once the old group is scaled to zero", () => {
    const recovery = recoverFleet(
      [
        { name: "old", createdAt: 1, desired: 0, minSize: 0, maxSize: 6 },
        { name: "current", createdAt: 2, desired: 6, minSize: 0, maxSize: 6 },
      ],
      6
    );
    expect(recovery.canonicalName).toBe("current");
    expect(recovery.deleteNames).toEqual(["old"]);
    expect(recovery.minSize).toBe(6);
  });

  test("a manual scale-out above the floor is preserved", () => {
    const recovery = recoverFleet(
      [{ name: "only", createdAt: 1, desired: 8, minSize: 6, maxSize: 8 }],
      6
    );
    expect(recovery).toEqual({
      canonicalName: "only",
      deleteNames: [],
      desired: 8,
      minSize: 6,
      maxSize: 8,
    });
  });
});

describe("nextReplacementStep", () => {
  test("a two-instance processor retires one before launching a replacement", () => {
    const limits = replacementLimits(2, 50, 100);
    expect(
      nextReplacementStep({ oldDesired: 2, newDesired: 0 }, limits)
    ).toEqual({
      kind: "retire",
      count: 1,
    });
    expect(
      nextReplacementStep({ oldDesired: 1, newDesired: 0 }, limits)
    ).toEqual({
      kind: "launch",
      count: 1,
    });
  });
});
