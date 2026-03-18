import {
  set_trial_context,
  type StimBank,
  type TaskSettings,
  type TrialBuilder,
  type TrialSnapshot
} from "psyflow-web";

import { parse_drifting_condition, reward_from_draw, type RewardTracker } from "./utils";

function getMachineLabel(stimBank: StimBank, key: "machine_left_label" | "machine_right_label", fallback: string): string {
  try {
    const stim = stimBank.resolve(key);
    if ("text" in stim && typeof stim.text === "string") {
      return stim.text;
    }
  } catch {
    // use fallback
  }
  return fallback;
}

function resolveChoiceKey(
  response: unknown,
  fallbackSide: "left" | "right",
  leftKey: string,
  rightKey: string
): string {
  if (response === leftKey || response === rightKey) {
    return String(response);
  }
  return fallbackSide === "left" ? leftKey : rightKey;
}

function resolveChoiceSide(choiceKey: string, leftKey: string): "left" | "right" {
  return choiceKey === leftKey ? "left" : "right";
}

export function run_trial(
  trial: TrialBuilder,
  condition: string,
  context: {
    settings: TaskSettings;
    stimBank: StimBank;
    rewardTracker: RewardTracker;
    block_id: string;
    block_idx: number;
  }
): TrialBuilder {
  const { settings, stimBank, rewardTracker, block_id, block_idx } = context;
  const spec = parse_drifting_condition(condition);
  const triggerMap = (settings.triggers ?? {}) as Record<string, unknown>;

  const leftKey = String(settings.left_key ?? "f");
  const rightKey = String(settings.right_key ?? "j");
  const rewardWinValue = Number(settings.reward_win ?? 10);
  const rewardLossValue = Number(settings.reward_loss ?? 0);

  const leftLabel = getMachineLabel(stimBank, "machine_left_label", "左侧机器");
  const rightLabel = getMachineLabel(stimBank, "machine_right_label", "右侧机器");

  const preChoiceFixationDuration = Number(settings.pre_choice_fixation_duration ?? 0.5);
  const choiceDuration = Number(settings.choice_duration ?? 2.0);
  const choiceConfirmationDuration = Number(settings.choice_confirmation_duration ?? 0.35);
  const outcomeFeedbackDuration = Number(settings.outcome_feedback_duration ?? 0.8);
  const itiDuration = Number(settings.iti_duration ?? 0.6);

  const preChoiceFixation = trial.unit("pre_choice_fixation").addStim(stimBank.get("fixation"));
  set_trial_context(preChoiceFixation, {
    trial_id: trial.trial_id,
    phase: "pre_choice_fixation",
    deadline_s: preChoiceFixationDuration,
    valid_keys: [],
    block_id,
    condition_id: spec.condition_id,
    task_factors: {
      stage: "pre_choice_fixation",
      p_left: spec.p_left,
      p_right: spec.p_right,
      block_idx
    },
    stim_id: "fixation"
  });
  preChoiceFixation.show({ duration: preChoiceFixationDuration }).to_dict();

  const banditChoice = trial
    .unit("bandit_choice")
    .addStim(stimBank.get("machine_left"))
    .addStim(stimBank.get("machine_right"))
    .addStim(stimBank.get("machine_left_label"))
    .addStim(stimBank.get("machine_right_label"))
    .addStim(
      stimBank.get_and_format("choice_prompt", {
        deadline_s: choiceDuration.toFixed(1)
      })
    );
  set_trial_context(banditChoice, {
    trial_id: trial.trial_id,
    phase: "bandit_choice",
    deadline_s: choiceDuration,
    valid_keys: [leftKey, rightKey],
    block_id,
    condition_id: spec.condition_id,
    task_factors: {
      stage: "bandit_choice",
      p_left: spec.p_left,
      p_right: spec.p_right,
      left_key: leftKey,
      right_key: rightKey,
      block_idx
    },
    stim_id: "bandit_choice"
  });
  banditChoice
    .captureResponse({
      keys: [leftKey, rightKey],
      correct_keys: [leftKey, rightKey],
      duration: choiceDuration,
      terminate_on_response: false,
      response_trigger: {
        [leftKey]: Number(triggerMap.choice_left_press ?? 31),
        [rightKey]: Number(triggerMap.choice_right_press ?? 32)
      },
      timeout_trigger: Number(triggerMap.choice_no_response ?? 33)
    })
    .set_state({
      choice_key: (snapshot: TrialSnapshot) =>
        resolveChoiceKey(snapshot.units.bandit_choice?.response, spec.fallback_side, leftKey, rightKey),
      choice_side: (snapshot: TrialSnapshot) =>
        resolveChoiceSide(
          resolveChoiceKey(snapshot.units.bandit_choice?.response, spec.fallback_side, leftKey, rightKey),
          leftKey
        ),
      choice_prob: (snapshot: TrialSnapshot) =>
        resolveChoiceSide(
          resolveChoiceKey(snapshot.units.bandit_choice?.response, spec.fallback_side, leftKey, rightKey),
          leftKey
        ) === "left"
          ? spec.p_left
          : spec.p_right,
      missed_choice: (snapshot: TrialSnapshot) =>
        snapshot.units.bandit_choice?.response !== leftKey && snapshot.units.bandit_choice?.response !== rightKey,
      choice_rt: (snapshot: TrialSnapshot) =>
        snapshot.units.bandit_choice?.response_time ?? snapshot.units.bandit_choice?.rt
    })
    .to_dict();

  const choiceConfirmation = trial
    .unit("choice_confirmation")
    .addStim(stimBank.get("machine_left"))
    .addStim(stimBank.get("machine_right"))
    .addStim(stimBank.get("machine_left_label"))
    .addStim(stimBank.get("machine_right_label"))
    .addStim((snapshot: TrialSnapshot) =>
      snapshot.units.bandit_choice?.choice_side === "left"
        ? stimBank.get("highlight_left")
        : stimBank.get("highlight_right")
    )
    .addStim((snapshot: TrialSnapshot) =>
      stimBank.get_and_format("target_prompt", {
        choice_label: snapshot.units.bandit_choice?.choice_side === "left" ? leftLabel : rightLabel
      })
    );
  set_trial_context(choiceConfirmation, {
    trial_id: trial.trial_id,
    phase: "choice_confirmation",
    deadline_s: choiceConfirmationDuration,
    valid_keys: [],
    block_id,
    condition_id: spec.condition_id,
    task_factors: {
      stage: "choice_confirmation",
      p_left: spec.p_left,
      p_right: spec.p_right,
      block_idx
    },
    stim_id: "selection_confirmation"
  });
  choiceConfirmation.show({ duration: choiceConfirmationDuration }).to_dict();

  const outcomeFeedback = trial
    .unit("outcome_feedback")
    .addStim((snapshot: TrialSnapshot) => {
      const choiceSide = resolveChoiceSide(
        String(snapshot.units.bandit_choice?.choice_key ?? leftKey),
        leftKey
      );
      const rewardWin = reward_from_draw({
        choice_side: choiceSide,
        p_left: spec.p_left,
        p_right: spec.p_right,
        draw_u: spec.reward_draw_u
      });
      const rewardDelta = rewardWin ? rewardWinValue : rewardLossValue;
      const totalScore = rewardTracker.current() + rewardDelta;
      return rewardWin
        ? stimBank.get_and_format("feedback_win", {
            reward_delta: rewardDelta,
            total_score: totalScore
          })
        : stimBank.get_and_format("feedback_loss", {
            reward_delta: rewardDelta,
            total_score: totalScore
          });
    });
  set_trial_context(outcomeFeedback, {
    trial_id: trial.trial_id,
    phase: "outcome_feedback",
    deadline_s: outcomeFeedbackDuration,
    valid_keys: [],
    block_id,
    condition_id: spec.condition_id,
    task_factors: {
      stage: "outcome_feedback",
      p_left: spec.p_left,
      p_right: spec.p_right,
      block_idx
    },
    stim_id: "outcome_feedback"
  });
  outcomeFeedback
    .show({ duration: outcomeFeedbackDuration })
    .set_state({
      reward_win: (snapshot: TrialSnapshot) =>
        reward_from_draw({
          choice_side: resolveChoiceSide(String(snapshot.units.bandit_choice?.choice_key ?? leftKey), leftKey),
          p_left: spec.p_left,
          p_right: spec.p_right,
          draw_u: spec.reward_draw_u
        }),
      reward_delta: (snapshot: TrialSnapshot) =>
        reward_from_draw({
          choice_side: resolveChoiceSide(String(snapshot.units.bandit_choice?.choice_key ?? leftKey), leftKey),
          p_left: spec.p_left,
          p_right: spec.p_right,
          draw_u: spec.reward_draw_u
        })
          ? rewardWinValue
          : rewardLossValue,
      total_score: (snapshot: TrialSnapshot) =>
        rewardTracker.current() +
        (reward_from_draw({
          choice_side: resolveChoiceSide(String(snapshot.units.bandit_choice?.choice_key ?? leftKey), leftKey),
          p_left: spec.p_left,
          p_right: spec.p_right,
          draw_u: spec.reward_draw_u
        })
          ? rewardWinValue
          : rewardLossValue)
    })
    .to_dict();

  const iti = trial.unit("iti").addStim(stimBank.get("fixation"));
  set_trial_context(iti, {
    trial_id: trial.trial_id,
    phase: "iti",
    deadline_s: itiDuration,
    valid_keys: [],
    block_id,
    condition_id: spec.condition_id,
    task_factors: {
      stage: "iti",
      block_idx
    },
    stim_id: "fixation"
  });
  iti.show({ duration: itiDuration }).to_dict();

  trial.finalize((snapshot, _runtime, helpers) => {
    const choiceKey = String(snapshot.units.bandit_choice?.choice_key ?? leftKey);
    const choiceSide = resolveChoiceSide(choiceKey, leftKey);
    const choiceProb = choiceSide === "left" ? spec.p_left : spec.p_right;
    const missedChoice = snapshot.units.bandit_choice?.missed_choice === true;
    const choiceRt = snapshot.units.bandit_choice?.choice_rt;
    const rewardWin = reward_from_draw({
      choice_side: choiceSide,
      p_left: spec.p_left,
      p_right: spec.p_right,
      draw_u: spec.reward_draw_u
    });
    const rewardDelta = rewardWin ? rewardWinValue : rewardLossValue;
    const totalScore = rewardTracker.update(rewardDelta);
    helpers.setTrialState("trial_index", spec.trial_index);
    helpers.setTrialState("condition_id", spec.condition_id);
    helpers.setTrialState("p_left", spec.p_left);
    helpers.setTrialState("p_right", spec.p_right);
    helpers.setTrialState("fallback_side", spec.fallback_side);
    helpers.setTrialState("reward_draw_u", spec.reward_draw_u);
    helpers.setTrialState("left_reward_prob_pct", `${Math.round(spec.p_left * 100)}%`);
    helpers.setTrialState("right_reward_prob_pct", `${Math.round(spec.p_right * 100)}%`);
    helpers.setTrialState("choice_key", choiceKey);
    helpers.setTrialState("choice_side", choiceSide);
    helpers.setTrialState("choice_prob", choiceProb);
    helpers.setTrialState("choice_rt", choiceRt);
    helpers.setTrialState("missed_choice", missedChoice);
    helpers.setTrialState("reward_win", rewardWin);
    helpers.setTrialState("reward_delta", rewardDelta);
    helpers.setTrialState("total_score", totalScore);
  });

  return trial;
}
