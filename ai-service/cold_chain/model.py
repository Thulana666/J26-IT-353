"""CNN-LSTM network for cold-chain risk (definition only; needs PyTorch).

  input  (batch, steps, len(FEATURES)) from preprocessing.build_sequence
  Conv1d layers  local patterns in the sensor sequence (spikes, short trends)
  LSTM           longer temporal dependencies (sustained drift, stops, delays)
  head           probability of a temperature excursion within the horizon

PyTorch is not part of requirements.txt (the service runs without it); install
requirements-training.txt to train. No trained weights or results exist yet.
"""

from __future__ import annotations

from .preprocessing import FEATURES

try:  # pragma: no cover - only with the training requirements installed
    import torch
    from torch import nn
except ImportError:  # pragma: no cover
    torch = None
    nn = None


def build_model(n_features: int = len(FEATURES), conv_channels: int = 32, lstm_hidden: int = 64, dropout: float = 0.2):
    if nn is None:
        raise RuntimeError("PyTorch is not installed: pip install -r requirements-training.txt")

    class CnnLstm(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv1d(n_features, conv_channels, kernel_size=3, padding=1),
                nn.ReLU(),
                nn.Conv1d(conv_channels, conv_channels, kernel_size=3, padding=1),
                nn.ReLU(),
            )
            self.lstm = nn.LSTM(conv_channels, lstm_hidden, batch_first=True)
            self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(lstm_hidden, 1))

        def forward(self, x):  # x: (batch, steps, features)
            h = self.conv(x.transpose(1, 2)).transpose(1, 2)
            out, _ = self.lstm(h)
            return torch.sigmoid(self.head(out[:, -1, :])).squeeze(-1)

    return CnnLstm()
