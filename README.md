# H000021 Drifting Double-Bandit

HTML/browser preview of the Drifting Double-Bandit task built with `psyflow-web`.
Trial procedure, drifting reward probabilities, no-response fallback behavior, and score accumulation are aligned to local `T000021-drifting-double-bandit`, with shorter block/trial counts for preview.

## Layout

- `main.ts`: task orchestration
- `config/config.yaml`: declarative config
- `src/run_trial.ts`: trial logic
- `src/utils.ts`: drifting condition generation, reward helpers, and summary helpers

## Run

From `e:\xhmhc\TaskBeacon\psyflow-web`:

```powershell
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:4173/?task=H000021-drifting-double-bandit
```
