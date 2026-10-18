"""Component 2: cold-chain risk prediction (CNN-LSTM).

The model is NOT trained yet. This package holds what does not depend on a
trained model: the request contract shared with the Node.js backend
(schemas.py), the sequence preprocessing (preprocessing.py), the network
definition (model.py) and the training script (training/). Until trained
weights exist in models/, POST /cold-chain/predict answers 501 and the backend
uses its clearly labelled rule-based prototype instead.
"""
