// How many instances may exist across the old and new ASGs during a
// Consul replacement. AWS applies MaxHealthyPercentage inside one group.
// A new-instances deploy is two groups, so the overlap has to be enforced here.
//
// 200 keeps today's behavior: launch the whole new fleet, then retire the old.
// 110 on a 6-instance fleet rounds up to 7 total, which is one extra box.

export type ReplacementLimits = {
  target: number;
  maxTotal: number;
  minAlive: number;
};

export type FleetCounts = {
  oldDesired: number;
  newDesired: number;
};

export type ReplacementStep =
  | { kind: "done" }
  | { kind: "launch"; count: number }
  | { kind: "retire"; count: number }
  | { kind: "stuck" };

export type AsgSnapshot = {
  name: string;
  createdAt: number;
  desired: number;
  minSize: number;
  maxSize: number;
};

// The fleet a roll replaces. A roll that died mid-way leaves the pre-roll ASG
// and a partial one, both serving, so every ASG with instances is part of the
// previous fleet. They are retired by the roll, oldest first, and never grown
// or deleted up front: either would cost capacity or launch old-release
// instances only to retire them. Only empty ASGs are safe to delete.
export type RollPlan = {
  previous: AsgSnapshot[];
  emptyNames: string[];
  previousDesired: number;
  target: number;
  minSize: number;
  maxSize: number;
};

export function planRoll(asgs: AsgSnapshot[], floor: number): RollPlan {
  const sorted = [...asgs].sort((a, b) => a.createdAt - b.createdAt);
  const previous = sorted.filter((asg) => asg.desired > 0);
  // A crashed roll splits the fleet across groups, so the largest one is a
  // lower bound on the pre-roll size, not the sum.
  const target = Math.max(floor, ...previous.map((asg) => asg.desired));
  const reference = previous[0] ?? sorted[0];
  const minSize =
    reference && reference.minSize > 0
      ? Math.min(reference.minSize, target)
      : Math.min(Math.max(floor, 1), target);
  const maxSize = Math.max(reference?.maxSize ?? 0, target, minSize);
  return {
    previous,
    emptyNames: sorted
      .filter((asg) => asg.desired === 0)
      .map((asg) => asg.name),
    previousDesired: previous.reduce((sum, asg) => sum + asg.desired, 0),
    target,
    minSize,
    maxSize,
  };
}

export function replacementLimits(
  target: number,
  minHealthyPercentage: number,
  maxHealthyPercentage: number
): ReplacementLimits {
  return {
    target,
    maxTotal: Math.max(
      target,
      Math.ceil((target * maxHealthyPercentage) / 100)
    ),
    minAlive: Math.min(
      target,
      Math.ceil((target * minHealthyPercentage) / 100)
    ),
  };
}

export function nextReplacementStep(
  counts: FleetCounts,
  limits: ReplacementLimits
): ReplacementStep {
  const { oldDesired, newDesired } = counts;
  const { target, maxTotal, minAlive } = limits;
  if (newDesired >= target && oldDesired === 0) {
    return { kind: "done" };
  }

  const total = oldDesired + newDesired;
  const room = maxTotal - total;
  if (newDesired < target && room > 0) {
    return { kind: "launch", count: Math.min(room, target - newDesired) };
  }

  const canRetire = total - minAlive;
  if (oldDesired > 0 && canRetire > 0) {
    return { kind: "retire", count: Math.min(oldDesired, canRetire) };
  }

  return { kind: "stuck" };
}
