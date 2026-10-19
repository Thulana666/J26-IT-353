"""CNN-LSTM network for the temperature-excursion risk (needs PyTorch).

  input  (batch, steps, len(FEATURES)) from preprocessing.sequence_at, scaled
  Conv1d layers  local patterns in the sensor sequence (spikes, short trends)
  LSTM           longer temporal dependencies (sustained drift, stops, delays)
  head           one logit; sigmoid(logit) = probability of a temperature
                 excursion within the horizon

All sizes are arguments (saved with the weights as "hyperparameters").
PyTorch is not part of requirements.txt (the service runs without it);
install requirements-training.txt to train.
"""

from __future__ import annotations

from .preprocessing import FEATURES

try:  # pragma: no cover - only with the training requirements installed
    import torch
    from torch import nn
except ImportError:  # pragma: no cover
    torch = None
    nn = None


def build_model(
    n_features: int = len(FEATURES),
    conv_channels: int = 32,
    kernel_size: int = 3,
    conv_layers: int = 2,
    lstm_hidden: int = 64,
    lstm_layers: int = 1,
    dropout: float = 0.2,
):
    if nn is None:
        raise RuntimeError("PyTorch is not installed: pip install -r requirements-training.txt")
    if kernel_size % 2 == 0:
        raise ValueError("kernel_size must be odd (the sequence length is kept)")

    class CnnLstm(nn.Module):
        def __init__(self):
            super().__init__()
            layers = []
            for i in range(conv_layers):
                layers += [nn.Conv1d(n_features if i == 0 else conv_channels, conv_channels, kernel_size, padding=kernel_size // 2), nn.ReLU()]
            self.conv = nn.Sequential(*layers)
            self.lstm = nn.LSTM(conv_channels, lstm_hidden, num_layers=lstm_layers, batch_first=True, dropout=dropout if lstm_layers > 1 else 0.0)
            self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(lstm_hidden, 1))

        def forward(self, x):  # x: (batch, steps, features) -> logits (batch,)
            h = self.conv(x.transpose(1, 2)).transpose(1, 2)
            out, _ = self.lstm(h)
            return self.head(out[:, -1, :]).squeeze(-1)

    return CnnLstm()
