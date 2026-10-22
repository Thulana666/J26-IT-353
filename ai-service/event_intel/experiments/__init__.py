"""Isolated research experiments for the Component 1 event classifier.

Compares the frozen rules baseline (event_intel.classifier, unchanged), a trained text classifier
(a pretrained transformer when installed; a pure-Python Naive Bayes stand-in otherwise) and a
hybrid of the two. Nothing here is imported by the FastAPI service, the dashboard or the collector.

    python -m event_intel.experiments.run --model nb --tier confirmed_high

See ai-service/data/experiments/EXPERIMENT_REPORT_v1.md for the method and results.
"""
