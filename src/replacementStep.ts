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

// Which ASG to keep when a previous roll died mid-way and left two groups.
// The oldest group that still has instances is the pre-roll fleet. A newer
// group is only the fleet once the older one has already been scaled to zero.
export type FleetRecovery = {
  canonicalName: string;
  deleteNames: string[];
  desired: number;
  minSize: number;
  maxSize: number;
};

export function recoverFleet(
  asgs: AsgSnapshot[],
  floor: number
): FleetRecovery {
  const sorted = [...asgs].sort((a, b) => a.createdAt - b.createdAt);
  const withCapacity = sorted.filter((asg) => asg.desired > 0);
  const canonical = withCapacity[0] ?? sorted[0];
  const desired = Math.max(canonical.desired, floor);
  const minSize =
    canonical.minSize > 0
      ? Math.min(canonical.minSize, desired)
      : Math.min(Math.max(floor, 1), desired);
  const maxSize = Math.max(canonical.maxSize, desired, minSize);
  return {
    canonicalName: canonical.name,
    deleteNames: sorted
      .filter((asg) => asg.name !== canonical.name)
      .map((asg) => asg.name),
    desired,
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
