Installed models for the AI service, one folder per task, written by
`python -m cold_chain.training.install`:

- `temperature/`: temperature-excursion risk (CNN-LSTM `model.pt` or a
  scikit-learn baseline `model.joblib`)
- `delay/`: late-delivery risk (scikit-learn `model.joblib`)

Each has a `manifest.json` with the model, version, decision threshold, the
training preprocessing (grid, sequence length, horizon, skip rules), the
dataset version and the model's validation/test metrics.
`cold_chain/inference.py` predicts with exactly that preprocessing.

There are none yet: no model has been trained on real data, so
`/cold-chain/predict` answers 501 and the backend uses its labelled
rule-based prototype. Models trained on test/simulated data are refused here.

Workflow (from ai-service/, with requirements-training.txt installed):

1. `node --env-file=.env scripts/export-cold-chain-dataset.js` (from backend/): real trips and readings
2. `python -m cold_chain.training.build_dataset --export <export folder>`: labels, features, chronological split
3. Temperature: `python -m cold_chain.training.baselines --dataset <processed folder>` and
   `python -m cold_chain.training.train --dataset <processed folder>` (CNN-LSTM), then
   `python -m cold_chain.training.compare --runs <baselines run> <cnn_lstm run>` (selection on validation)
4. Delay: `python -m cold_chain.training.delay --dataset <processed folder>` (baselines + tuned gradient boosting, trip-balanced)
5. `python -m cold_chain.training.install --comparison <comparison folder>` and
   `python -m cold_chain.training.install --run <delay run>`

Overall risk (cold_chain/risk.py), configured with environment variables:
`COLD_CHAIN_RISK_COMBINATION` (`max` default, `noisy_or`, `weighted_mean`),
`COLD_CHAIN_RISK_WEIGHTS` (e.g. `temperature=0.7,delay=0.3`),
`COLD_CHAIN_RISK_MEDIUM` (0.3) and `COLD_CHAIN_RISK_HIGH` (0.7).
