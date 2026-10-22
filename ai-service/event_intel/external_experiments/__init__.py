"""External-dataset experiments for the Component 1 event classifier (isolated research code).

HumAID, Disaster Tweets and BBC News are used only where a defensible role exists:
  * their ORIGINAL labels for their own tasks (humanitarian information type, real-disaster binary,
    news topic), never relabelled;
  * an explicit, versioned, rule-based mapping to the project's categories for a small, audited
    subset (label_source = "auto_mapped_v1"), never presented as human labels;
  * intermediate-task transfer (train on the external task, then fine-tune on the news articles).

Nothing here is imported by the FastAPI service, the dashboard or the collector.

    python -m event_intel.external_experiments.prepare            # audit + adapted datasets + splits
    python -m event_intel.external_experiments.train_eval --model nb --plan all
    .venv/Scripts/python.exe -m event_intel.external_experiments.train_eval --model transformer --plan B_humaid_intermediate --seed 42
    python -m event_intel.external_experiments.summarize

See ai-service/data/external_experiments/EXTERNAL_EXPERIMENTS_REPORT_v1.md.
"""
