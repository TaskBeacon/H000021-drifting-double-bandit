import { PythonRandom, type ReducedTrialRow } from "psyflow-web";

function clip(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

class PythonGaussRandom {
  private readonly rng: PythonRandom;
  private nextGauss: number | null = null;

  constructor(seed: number) {
    this.rng = new PythonRandom(seed);
  }

  random(): number {
    return this.rng.random();
  }

  gauss(mu = 0, sigma = 1): number {
    let z = this.nextGauss;
    this.nextGauss = null;
    if (z === null) {
      const x2pi = this.random() * Math.PI * 2;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.nextGauss = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }

  shuffle<T>(items: T[]): T[] {
    return this.rng.shuffle(items);
  }
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

function chooseFallbackSide(policy: unknown, rng: PythonGaussRandom): "left" | "right" {
  const normalized = String(policy ?? "random").trim().toLowerCase();
  if (normalized === "left") {
    return "left";
  }
  if (normalized === "right") {
    return "right";
  }
  return rng.random() < 0.5 ? "left" : "right";
}

function driftOnce(
  rng: PythonGaussRandom,
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
    const delta = rng.gauss(0, driftSigma);
    const nextLeft = clip(pLeft + delta, minProb, maxProb);
    const nextRightRaw = clip(1 - nextLeft, minProb, maxProb);
    const correctedLeft = clip(1 - nextRightRaw, minProb, maxProb);
    return [correctedLeft, nextRightRaw];
  }
  const nextLeft = clip(pLeft + rng.gauss(0, driftSigma), minProb, maxProb);
  const nextRight = clip(pRight + rng.gauss(0, driftSigma), minProb, maxProb);
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
  const rng = new PythonGaussRandom(Math.trunc(seed));
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
      reward_draw_u: rng.random()
    });
    [pLeft, pRight] = driftOnce(rng, pLeft, pRight, driftSigma, minProb, maxProb, antiCorrelated);
  }

  if (randomizeWithinBlock) {
    rng.shuffle(conditions);
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
  left_rate: number;
  win_rate: number;
  no_response_rate: number;
  total_score: number;
} {
  const blockRows = rows.filter((row) => String(row.block_id ?? "") === blockId);
  const n = Math.max(1, blockRows.length);
  const leftRate = blockRows.filter((row) => String(row.choice_side ?? "") === "left").length / n;
  const winRate = blockRows.filter((row) => row.reward_win === true).length / n;
  const noResponseRate = blockRows.filter((row) => row.missed_choice === true).length / n;
  const totalScore = blockRows.reduce((sum, row) => sum + Number(row.reward_delta ?? 0), 0);
  return {
    left_rate: leftRate,
    win_rate: winRate,
    no_response_rate: noResponseRate,
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
