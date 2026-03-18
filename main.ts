import {
  BlockUnit,
  StimBank,
  SubInfo,
  TaskSettings,
  TrialBuilder,
  count_down,
  mountTaskApp,
  next_trial_id,
  parsePsyflowConfig,
  reset_trial_counter,
  type CompiledTrial,
  type Resolvable,
  type RuntimeView,
  type StimRef,
  type StimSpec,
  type TrialSnapshot
} from "psyflow-web";

import configText from "./config/config.yaml?raw";
import { run_trial } from "./src/run_trial";
import {
  RewardTracker,
  generate_drifting_bandit_conditions,
  parse_drifting_condition,
  summarizeBlock,
  summarizeOverall,
  type ConditionGenerationConfig
} from "./src/utils";

const instructionVoiceAsset = new URL("./assets/instruction_text_voice.mp3", import.meta.url).href;

function buildWaitTrial(
  meta: { trial_id: string; condition: string; trial_index: number },
  blockId: string | null,
  unitLabel: string,
  stimInputs: Array<Resolvable<StimRef | StimSpec | null>>
): CompiledTrial {
  const trial = new TrialBuilder({
    trial_id: meta.trial_id,
    block_id: blockId,
    trial_index: meta.trial_index,
    condition: meta.condition
  });
  trial.unit(unitLabel).addStim(...stimInputs).waitAndContinue();
  return trial.build();
}

export async function run(root: HTMLElement): Promise<void> {
  const parsed = parsePsyflowConfig(configText, import.meta.url);
  const settings = TaskSettings.from_dict(parsed.task_config);
  const subInfo = new SubInfo(parsed.subform_config);
  const stimBank = new StimBank(parsed.stim_config);
  const conditionGenerationConfig = (parsed.raw.condition_generation ??
    {}) as ConditionGenerationConfig;

  settings.triggers = parsed.trigger_config;

  if (settings.voice_enabled) {
    stimBank.convert_to_voice("instruction_text", {
      voice: String(settings.voice_name ?? "zh-CN-YunyangNeural"),
      rate: 1,
      assetFiles: {
        instruction_text: instructionVoiceAsset
      },
      fallbackToSpeech: false
    });
  }

  await mountTaskApp({
    root,
    task_id: "H000021-drifting-double-bandit",
    task_name: "Drifting Double-Bandit Task",
    task_description: "HTML preview aligned to local psyflow drifting double-bandit procedure and parameters.",
    settings,
    subInfo,
    stimBank,
    buildTrials: (): CompiledTrial[] => {
      reset_trial_counter();
      const compiledTrials: CompiledTrial[] = [];
      const rewardTracker = new RewardTracker();
      const trialPerBlock = Math.max(
        1,
        Number(settings.trials_per_block ?? settings.trial_per_block ?? 1)
      );

      const instructionInputs: Array<Resolvable<StimRef | StimSpec | null>> = [stimBank.get("instruction_text")];
      if (settings.voice_enabled) {
        instructionInputs.push(stimBank.get("instruction_text_voice"));
      }
      compiledTrials.push(
        buildWaitTrial(
          { trial_id: "instruction", condition: "instruction", trial_index: -1 },
          null,
          "instruction_text",
          instructionInputs
        )
      );

      const totalBlocks = Math.max(1, Number(settings.total_blocks ?? 1));
      for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex += 1) {
        const blockId = `block_${blockIndex}`;
        compiledTrials.push(
          ...count_down({
            seconds: 3,
            block_id: blockId,
            trial_id_prefix: `countdown_${blockId}`,
            stim: { color: "white", height: 3.5 }
          })
        );

        const block = new BlockUnit({
          block_id: blockId,
          block_idx: blockIndex,
          settings,
          n_trials: trialPerBlock
        }).generate_conditions({
          func: generate_drifting_bandit_conditions,
          args: [conditionGenerationConfig]
        });

        block.conditions.forEach((condition, trialIndex) => {
          const spec = parse_drifting_condition(condition);
          const trial = new TrialBuilder({
            trial_id: next_trial_id(),
            block_id: block.block_id,
            trial_index: trialIndex,
            condition: spec.condition_id
          });
          run_trial(trial, condition, {
            settings,
            stimBank,
            rewardTracker,
            block_id: block.block_id,
            block_idx: blockIndex
          });
          compiledTrials.push(trial.build());
        });

        compiledTrials.push(
          buildWaitTrial(
            {
              trial_id: `block_break_${blockIndex}`,
              condition: "block_break",
              trial_index: Number(block.conditions.length) + blockIndex
            },
            block.block_id,
            "block_break",
            [
              (_snapshot: TrialSnapshot, runtime: RuntimeView) => {
                const summary = summarizeBlock(runtime.getReducedRows(), block.block_id);
                return stimBank.get_and_format("block_break", {
                  block_num: blockIndex + 1,
                  total_blocks: settings.total_blocks,
                  left_rate: summary.left_rate,
                  win_rate: summary.win_rate,
                  no_response_rate: summary.no_response_rate,
                  total_score: summary.total_score
                });
              }
            ]
          )
        );
      }

      compiledTrials.push(
        buildWaitTrial(
          {
            trial_id: "goodbye",
            condition: "goodbye",
            trial_index: Number(settings.total_trials ?? 0)
          },
          null,
          "goodbye",
          [
            (_snapshot: TrialSnapshot, runtime: RuntimeView) => {
              const summary = summarizeOverall(runtime.getReducedRows());
              return stimBank.get_and_format("good_bye", summary);
            }
          ]
        )
      );

      return compiledTrials;
    }
  });
}

export async function main(root: HTMLElement): Promise<void> {
  await run(root);
}

export default main;
