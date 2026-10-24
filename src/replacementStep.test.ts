import { describe, expect, test } from "bun:test";

import {
  nextReplacementStep,
  planRoll,
  replacementLimits,
  type ReplacementLimits,
} from "./replacementStep";

// Runs a roll to completion and returns the total instance count after each step.
function rollTotals(limits: ReplacementLimits, oldDesired: number) {
  let newDesired = 0;
  const totals: number[] = [];
  for (let i = 0; i < 40; i++) {
    const step = nextReplacementStep({ oldDesired, newDesired }, limits);
    if (step.kind === "done") return totals;
    if (step.kind === "stuck") throw new Error("roll got stuck");
    if (step.kind === "launch") newDesired += step.count;
    if (step.kind === "retire") oldDesired -= step.count;
    totals.push(oldDesired + newDesired);
  }
  throw new Error("roll did not finish");
}

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

describe("planRoll", () => {
  test("a capacity raise launches new instances instead of growing the old fleet", () => {
    const plan = planRoll(
      [{ name: "old", createdAt: 1, desired: 2, minSize: 2, maxSize: 3 }],
      6
    );
    expect(plan.previous.map((asg) => asg.name)).toEqual(["old"]);
    expect(plan.previousDesired).toBe(2);
    expect(plan.target).toBe(6);

    const totals = rollTotals(replacementLimits(6, 100, 110), 2);
    expect(Math.max(...totals)).toBe(7);
  });

  test("a crashed roll keeps the partial fleet serving instead of deleting it", () => {
    const plan = planRoll(
      [
        { name: "old", createdAt: 1, desired: 3, minSize: 0, maxSize: 7 },
        { name: "partial", createdAt: 2, desired: 3, minSize: 0, maxSize: 7 },
      ],
      6
    );
    expect(plan.previous.map((asg) => asg.name)).toEqual(["old", "partial"]);
    expect(plan.emptyNames).toEqual([]);
    expect(plan.previousDesired).toBe(6);
    expect(plan.target).toBe(6);

    const totals = rollTotals(replacementLimits(6, 100, 110), 6);
    expect(Math.min(...totals)).toBe(6);
    expect(Math.max(...totals)).toBe(7);
  });

  test("a crashed 200% roll retires down to the target without a dip", () => {
    const plan = planRoll(
      [
        { name: "old", createdAt: 1, desired: 6, minSize: 0, maxSize: 12 },
        { name: "partial", createdAt: 2, desired: 6, minSize: 0, maxSize: 12 },
      ],
      6
    );
    expect(plan.target).toBe(6);
    expect(plan.previousDesired).toBe(12);

    const totals = rollTotals(replacementLimits(6, 100, 200), 12);
    expect(Math.min(...totals)).toBe(6);
    expect(Math.max(...totals)).toBe(12);
  });

  test("an empty newer ASG is deleted and is not part of the fleet", () => {
    const plan = planRoll(
      [
        { name: "old", createdAt: 1, desired: 6, minSize: 0, maxSize: 6 },
        { name: "empty", createdAt: 2, desired: 0, minSize: 0, maxSize: 6 },
      ],
      6
    );
    expect(plan.previous.map((asg) => asg.name)).toEqual(["old"]);
    expect(plan.emptyNames).toEqual(["empty"]);
    expect(plan.target).toBe(6);
    expect(plan.minSize).toBe(6);
  });

  test("a finished new fleet is kept once the old group is scaled to zero", () => {
    const plan = planRoll(
      [
        { name: "old", createdAt: 1, desired: 0, minSize: 0, maxSize: 6 },
        { name: "current", createdAt: 2, desired: 6, minSize: 0, maxSize: 6 },
      ],
      6
    );
    expect(plan.previous.map((asg) => asg.name)).toEqual(["current"]);
    expect(plan.emptyNames).toEqual(["old"]);
    expect(plan.minSize).toBe(6);
  });

  test("a manual scale-out above the floor is preserved", () => {
    const plan = planRoll(
      [{ name: "only", createdAt: 1, desired: 8, minSize: 6, maxSize: 8 }],
      6
    );
    expect(plan).toMatchObject({
      emptyNames: [],
      previousDesired: 8,
      target: 8,
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
