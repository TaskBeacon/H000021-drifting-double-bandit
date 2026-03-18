import type { ReducedTrialRow } from "psyflow-web";

function clip(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function makeSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianFromRng(rng: () => number): number {
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  const radius = Math.sqrt(-2.0 * Math.log(u1));
  const theta = 2.0 * Math.PI * u2;
  return radius * Math.cos(theta);
}

function toPercent(value: number): string {
  return `${(clip(value, 0, 1) * 100).toFixed(1)}%`;
}

export class RewardTracker {
  private cumulativeReward = 0;

  constructor(initialReward = 0) {
    this.cumulativeReward = Number(initialReward);
  }

  update(delta: number): number {
    this.cumulativeReward += Number(delta);
    return this.cumulativeReward;
  }

  current(): number {
    return this.cumulativeReward;
  }
}

export interface DriftingBanditConditionSpec {
  p_left: number;
  p_right: number;
  condition_id: string;
  trial_index: number;
  fallback_side: "left" | "right";
  reward_draw_u: number;
}

export interface ConditionGenerationConfig {
  initial_left_prob?: number;
  initial_right_prob?: number;
  drift_sigma?: number;
  min_prob?: number;
  max_prob?: number;
  anti_correlated?: boolean;
  no_choice_policy?: "random" | "left" | "right" | string;
  randomize_within_block?: boolean;
  enable_logging?: boolean;
}

function chooseFallbackSide(policy: unknown, rng: () => number): "left" | "right" {
  const normalized = String(policy ?? "random").trim().toLowerCase();
  if (normalized === "left") {
    return "left";
  }
  if (normalized === "right") {
    return "right";
  }
  return rng() < 0.5 ? "left" : "right";
}

function driftOnce(
  rng: () => number,
  pLeft: number,
  pRight: number,
  driftSigma: number,
  minProb: number,
  maxProb: number,
  antiCorrelated: boolean
): [number, number] {
  if (driftSigma <= 0) {
    return [pLeft, pRight];
  }
  if (antiCorrelated) {
    const delta = gaussianFromRng(rng) * driftSigma;
    const nextLeft = clip(pLeft + delta, minProb, maxProb);
    const nextRightRaw = clip(1 - nextLeft, minProb, maxProb);
    const correctedLeft = clip(1 - nextRightRaw, minProb, maxProb);
    return [correctedLeft, nextRightRaw];
  }
  const nextLeft = clip(pLeft + gaussianFromRng(rng) * driftSigma, minProb, maxProb);
  const nextRight = clip(pRight + gaussianFromRng(rng) * driftSigma, minProb, maxProb);
  return [nextLeft, nextRight];
}

export function generate_drifting_bandit_conditions(
  n_trials: number,
  _condition_labels: string[],
  config: ConditionGenerationConfig | undefined,
  seed: number
): string[] {
  const nTrials = Math.max(0, Math.trunc(n_trials));
  if (nTrials <= 0) {
    return [];
  }

  const cfg = config ?? {};
  const rng = makeSeededRandom(Math.trunc(seed));
  const minProb = clip(Number(cfg.min_prob ?? 0.1), 0, 1);
  const maxProb = clip(Number(cfg.max_prob ?? 0.9), minProb, 1);
  const driftSigma = Math.max(0, Number(cfg.drift_sigma ?? 0.05));
  const antiCorrelated = cfg.anti_correlated !== false;
  const randomizeWithinBlock = cfg.randomize_within_block === true;
  const noChoicePolicy = cfg.no_choice_policy ?? "random";

  let pLeft = clip(Number(cfg.initial_left_prob ?? 0.65), minProb, maxProb);
  let pRight = clip(Number(cfg.initial_right_prob ?? 0.35), minProb, maxProb);

  const conditions: DriftingBanditConditionSpec[] = [];
  for (let trialIndex = 1; trialIndex <= nTrials; trialIndex += 1) {
    const conditionId = `L${String(Math.round(pLeft * 100)).padStart(2, "0")}_R${String(
      Math.round(pRight * 100)
    ).padStart(2, "0")}_t${String(trialIndex).padStart(3, "0")}`;
    conditions.push({
      p_left: Number(pLeft.toFixed(4)),
      p_right: Number(pRight.toFixed(4)),
      condition_id: conditionId,
      trial_index: trialIndex,
      fallback_side: chooseFallbackSide(noChoicePolicy, rng),
      reward_draw_u: rng()
    });
    [pLeft, pRight] = driftOnce(rng, pLeft, pRight, driftSigma, minProb, maxProb, antiCorrelated);
  }

  if (randomizeWithinBlock) {
    for (let index = conditions.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(rng() * (index + 1));
      [conditions[index], conditions[swapIndex]] = [conditions[swapIndex], conditions[index]];
    }
  }

  return conditions.map((item) => JSON.stringify(item));
}

export function parse_drifting_condition(condition: string): DriftingBanditConditionSpec {
  const parsed = JSON.parse(String(condition)) as Partial<DriftingBanditConditionSpec>;
  return {
    p_left: clip(Number(parsed.p_left ?? 0.5), 0, 1),
    p_right: clip(Number(parsed.p_right ?? 0.5), 0, 1),
    condition_id: String(parsed.condition_id ?? "L50_R50_t001"),
    trial_index: Math.max(1, Number(parsed.trial_index ?? 1)),
    fallback_side: parsed.fallback_side === "right" ? "right" : "left",
    reward_draw_u: clip(Number(parsed.reward_draw_u ?? 0.5), 0, 1)
  };
}

export function reward_from_draw(args: {
  choice_side: "left" | "right";
  p_left: number;
  p_right: number;
  draw_u: number;
}): boolean {
  const probability =
    args.choice_side === "left" ? clip(Number(args.p_left), 0, 1) : clip(Number(args.p_right), 0, 1);
  const drawU = clip(Number(args.draw_u), 0, 1);
  return drawU < probability;
}

export function summarizeBlock(rows: ReducedTrialRow[], blockId: string): {
  left_rate: string;
  win_rate: string;
  no_response_rate: string;
  total_score: number;
} {
  const blockRows = rows.filter((row) => String(row.block_id ?? "") === blockId);
  const n = Math.max(1, blockRows.length);
  const leftRate = blockRows.filter((row) => String(row.choice_side ?? "") === "left").length / n;
  const winRate = blockRows.filter((row) => row.reward_win === true).length / n;
  const noResponseRate = blockRows.filter((row) => row.missed_choice === true).length / n;
  const totalScore = blockRows.reduce((sum, row) => sum + Number(row.reward_delta ?? 0), 0);
  return {
    left_rate: toPercent(leftRate),
    win_rate: toPercent(winRate),
    no_response_rate: toPercent(noResponseRate),
    total_score: totalScore
  };
}

export function summarizeOverall(rows: ReducedTrialRow[]): {
  total_score: number;
  left_rate: string;
  win_rate: string;
  no_response_rate: string;
} {
  const n = Math.max(1, rows.length);
  const leftRate = rows.filter((row) => String(row.choice_side ?? "") === "left").length / n;
  const winRate = rows.filter((row) => row.reward_win === true).length / n;
  const noResponseRate = rows.filter((row) => row.missed_choice === true).length / n;
  const totalScore = rows.reduce((sum, row) => sum + Number(row.reward_delta ?? 0), 0);
  return {
    total_score: totalScore,
    left_rate: toPercent(leftRate),
    win_rate: toPercent(winRate),
    no_response_rate: toPercent(noResponseRate)
  };
}
