"""HTTP service for Component 1 event intelligence: POST /event-intel/classify.

Stateless (no database access): the backend sends one article, the service
returns the frozen rules result, the fine-tuned DistilRoBERTa category
prediction (when a valid checkpoint is configured) and the hybrid decision.
"""
