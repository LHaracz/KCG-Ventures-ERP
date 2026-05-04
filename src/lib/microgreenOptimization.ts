export type OptimizationMixComponent = {
  microgreenId: string;
  ratio: number;
};

export type OptimizationMix = {
  id: string;
  name: string;
  unitSizeOz: number;
  salePrice: number;
  isActive: boolean;
  components: OptimizationMixComponent[];
};

export type OptimizationInput = {
  availableOzByMicrogreen: Record<string, number>;
  microgreenNames: Record<string, string>;
  mixes: OptimizationMix[];
  singleUnitSizeOz?: number;
  singleSalePrice?: number;
  maxMixShare?: number;
  maxMixSpread?: number;
};

export type OptimizationResult = {
  totals: {
    profit: number;
    containers: number;
    mixContainers: number;
    singleContainers: number;
  };
  mixes: Array<{ mixId: string; mixName: string; containers: number }>;
  singles: Array<{ microgreenId: string; microgreenName: string; containers: number }>;
  leftoversOz: Array<{ microgreenId: string; microgreenName: string; leftoverOz: number }>;
  infeasibleReason?: string;
};

type Candidate = {
  mixCounts: number[];
  profit: number;
  containers: number;
  singles: Record<string, number>;
  leftovers: Record<string, number>;
};

const EPSILON = 1e-9;

function getMaxMixCount(mix: OptimizationMix, available: Record<string, number>): number {
  let maxCount = Number.POSITIVE_INFINITY;
  for (const component of mix.components) {
    const requiredPerContainer = mix.unitSizeOz * component.ratio;
    if (requiredPerContainer <= EPSILON) continue;
    const capacity = (available[component.microgreenId] ?? 0) / requiredPerContainer;
    maxCount = Math.min(maxCount, Math.floor(capacity + EPSILON));
  }
  return Number.isFinite(maxCount) ? Math.max(0, maxCount) : 0;
}

function applyMixCount(
  mix: OptimizationMix,
  count: number,
  source: Record<string, number>,
): Record<string, number> {
  const next = { ...source };
  for (const component of mix.components) {
    const used = count * mix.unitSizeOz * component.ratio;
    next[component.microgreenId] = Math.max(0, (next[component.microgreenId] ?? 0) - used);
  }
  return next;
}

function evaluateLeaf(
  mixes: OptimizationMix[],
  mixCounts: number[],
  available: Record<string, number>,
  singleUnitSizeOz: number,
  singleSalePrice: number,
): Candidate {
  const singles: Record<string, number> = {};
  let singleContainers = 0;
  for (const [microgreenId, oz] of Object.entries(available)) {
    const count = Math.floor((oz + EPSILON) / singleUnitSizeOz);
    singles[microgreenId] = Math.max(0, count);
    singleContainers += Math.max(0, count);
  }

  const mixContainers = mixCounts.reduce((sum, count) => sum + count, 0);
  let profit = singleContainers * singleSalePrice;
  for (let i = 0; i < mixes.length; i += 1) {
    profit += mixCounts[i] * mixes[i].salePrice;
  }

  return {
    mixCounts,
    singles,
    leftovers: available,
    profit,
    containers: mixContainers + singleContainers,
  };
}

function isBetter(a: Candidate, b: Candidate | null): boolean {
  if (!b) return true;
  if (a.profit > b.profit + EPSILON) return true;
  if (Math.abs(a.profit - b.profit) <= EPSILON && a.containers > b.containers) return true;
  return false;
}

function isFeasibleCandidate(params: {
  candidate: Candidate;
  feasibleMixIndices: Set<number>;
  maxMixShare: number;
  maxMixSpread: number;
}): boolean {
  const { candidate, feasibleMixIndices, maxMixShare, maxMixSpread } = params;
  const mixContainers = candidate.mixCounts.reduce((sum, count) => sum + count, 0);
  const totalContainers = mixContainers + Object.values(candidate.singles).reduce((sum, n) => sum + n, 0);
  if (totalContainers > 0) {
    const mixShare = mixContainers / totalContainers;
    if (mixShare > maxMixShare + EPSILON) return false;
  }

  const feasibleCounts: number[] = [];
  for (const mixIdx of feasibleMixIndices) {
    const count = candidate.mixCounts[mixIdx] ?? 0;
    if (count < 1) return false;
    feasibleCounts.push(count);
  }
  if (feasibleCounts.length > 1) {
    const minCount = Math.min(...feasibleCounts);
    const maxCount = Math.max(...feasibleCounts);
    if (maxCount - minCount > maxMixSpread + EPSILON) return false;
  }

  return true;
}

export function optimizeMicrogreenPlan(input: OptimizationInput): OptimizationResult {
  const singleUnitSizeOz = input.singleUnitSizeOz ?? 2;
  const singleSalePrice = input.singleSalePrice ?? 6;
  const maxMixShare = input.maxMixShare ?? 0.45;
  const maxMixSpread = input.maxMixSpread ?? 5;
  const activeMixes = input.mixes.filter((mix) => mix.isActive && mix.components.length > 0);
  const initialAvailable = { ...input.availableOzByMicrogreen };

  const mixIndices = activeMixes.map((_, i) => i);
  mixIndices.sort((a, b) => {
    const valueA = activeMixes[a].salePrice / activeMixes[a].unitSizeOz;
    const valueB = activeMixes[b].salePrice / activeMixes[b].unitSizeOz;
    return valueB - valueA;
  });
  const sortedMixes = mixIndices.map((i) => activeMixes[i]);
  const feasibleMixIndices = new Set<number>();
  for (let idx = 0; idx < sortedMixes.length; idx += 1) {
    if (getMaxMixCount(sortedMixes[idx], initialAvailable) > 0) {
      feasibleMixIndices.add(idx);
    }
  }

  let best: Candidate | null = null;
  const currentMixCounts = new Array(sortedMixes.length).fill(0);

  const dfs = (mixIdx: number, available: Record<string, number>, realizedProfit: number) => {
    const remainingOz = Object.values(available).reduce((sum, oz) => sum + oz, 0);
    const remainingBestDollarPerOz = Math.max(
      singleSalePrice / singleUnitSizeOz,
      ...sortedMixes.slice(mixIdx).map((mix) => mix.salePrice / mix.unitSizeOz),
    );
    const optimisticProfit = realizedProfit + remainingOz * remainingBestDollarPerOz;
    if (best && optimisticProfit < best.profit - EPSILON) {
      return;
    }

    if (mixIdx >= sortedMixes.length) {
      const leaf = evaluateLeaf(
        sortedMixes,
        [...currentMixCounts],
        available,
        singleUnitSizeOz,
        singleSalePrice,
      );
      if (
        !isFeasibleCandidate({
          candidate: leaf,
          feasibleMixIndices,
          maxMixShare,
          maxMixSpread,
        })
      ) {
        return;
      }
      if (isBetter(leaf, best)) {
        best = leaf;
      }
      return;
    }

    const mix = sortedMixes[mixIdx];
    const maxCount = getMaxMixCount(mix, available);
    for (let count = maxCount; count >= 0; count -= 1) {
      currentMixCounts[mixIdx] = count;
      const nextAvailable = applyMixCount(mix, count, available);
      dfs(mixIdx + 1, nextAvailable, realizedProfit + count * mix.salePrice);
    }
    currentMixCounts[mixIdx] = 0;
  };

  dfs(0, initialAvailable, 0);

  const winner =
    best ?? null;

  if (!winner) {
    const emptyLeftovers = Object.entries(initialAvailable)
      .map(([microgreenId, leftoverOz]) => ({
        microgreenId,
        microgreenName: input.microgreenNames[microgreenId] ?? "Unknown",
        leftoverOz: Math.max(0, leftoverOz),
      }))
      .sort((a, b) => a.microgreenName.localeCompare(b.microgreenName));
    return {
      totals: {
        profit: 0,
        containers: 0,
        mixContainers: 0,
        singleContainers: 0,
      },
      mixes: [],
      singles: [],
      leftoversOz: emptyLeftovers,
      infeasibleReason:
        "No feasible plan satisfies current mix constraints (mix share cap, all feasible mixes represented, and balance spread).",
    };
  }

  const mixes = sortedMixes
    .map((mix, idx) => ({
      mixId: mix.id,
      mixName: mix.name,
      containers: winner.mixCounts[idx] ?? 0,
    }))
    .filter((row) => row.containers > 0);

  const singles = Object.entries(winner.singles)
    .map(([microgreenId, containers]) => ({
      microgreenId,
      microgreenName: input.microgreenNames[microgreenId] ?? "Unknown",
      containers,
    }))
    .filter((row) => row.containers > 0)
    .sort((a, b) => a.microgreenName.localeCompare(b.microgreenName));

  const leftoversOz = Object.entries(winner.leftovers)
    .map(([microgreenId, leftoverOz]) => ({
      microgreenId,
      microgreenName: input.microgreenNames[microgreenId] ?? "Unknown",
      leftoverOz: Math.max(0, leftoverOz),
    }))
    .sort((a, b) => a.microgreenName.localeCompare(b.microgreenName));

  return {
    totals: {
      profit: winner.profit,
      containers: winner.containers,
      mixContainers: mixes.reduce((sum, m) => sum + m.containers, 0),
      singleContainers: singles.reduce((sum, s) => sum + s.containers, 0),
    },
    mixes,
    singles,
    leftoversOz,
  };
}
