"""Evaluation plots (PNG, matplotlib) for the cold-chain models.

Colours come from the validated chart palette and follow the model: each
model keeps its categorical colour and dash pattern in every plot. Only
logistic regression, random forest and gradient boosting (slots 1-3) pass
the colour-vision checks all together, so a comparison of more models is
drawn as small multiples (one panel per model, the others in grey). Reference
lines are muted grey and dashed, the confusion matrix uses the single-hue blue
ramp, and text stays in neutral ink. Plots of simulated/test data carry the
"not research results" banner. The numbers behind every plot are in the
metrics files (table view).
"""

from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
MODEL_COLORS = {
    "logistic_regression": "#2a78d6",
    "random_forest": "#eb6834",
    "gradient_boosting": "#1baf7a",
    "cnn_lstm": "#eda100",
    "gradient_boosting_tuned": "#e87ba4",
}
# Models whose colours can share one chart (validated together, all pairs).
OVERLAY_MODELS = frozenset({"logistic_regression", "random_forest", "gradient_boosting"})
# A dash pattern per model as well (secondary encoding): identical curves stay
# visible and the lines do not rely on colour alone.
MODEL_STYLES = {
    "logistic_regression": "-",
    "random_forest": (0, (6, 2)),
    "gradient_boosting": (0, (2, 2)),
    "cnn_lstm": (0, (8, 3, 2, 3)),
    "gradient_boosting_tuned": (0, (4, 1, 1, 1)),
}
MODEL_LABELS = {
    "logistic_regression": "Logistic regression",
    "random_forest": "Random forest",
    "gradient_boosting": "Gradient boosting",
    "gradient_boosting_tuned": "Gradient boosting (tuned)",
    "cnn_lstm": "CNN-LSTM",
    "no_skill": "No skill (training positive rate)",
}
BLUE_RAMP = LinearSegmentedColormap.from_list("blue", ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"])


def _style(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelcolor=INK_SECONDARY, labelsize=8)
    ax.xaxis.label.set_color(INK_SECONDARY)
    ax.yaxis.label.set_color(INK_SECONDARY)


def _banner(fig, banner: str | None):
    if banner:
        fig.text(
            0.5, 0.985, banner, ha="center", va="top", fontsize=8, color=INK,
            bbox={"facecolor": "#fff3cd", "edgecolor": "#eda100", "boxstyle": "round,pad=0.35"},
        )


def _figure(title: str, banner: str | None, size=(6.4, 4.8)):
    fig, ax = plt.subplots(figsize=size, dpi=150, facecolor=SURFACE)
    _style(ax)
    ax.set_title(title, color=INK, fontsize=11, loc="left", pad=22 if banner else 10)
    _banner(fig, banner)
    return fig, ax


def _save(fig, path: Path, top: float = 0.96) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout(rect=(0, 0, 1, top))
    fig.savefig(path, facecolor=SURFACE)
    plt.close(fig)
    return path


def _grid(ax):
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _legend(ax):
    ax.legend(frameon=False, fontsize=8, labelcolor=INK_SECONDARY, loc="lower right")


def _curve_chart(series: list, reference: tuple, path: Path, title: str, banner: str | None, *, xlabel: str, ylabel: str) -> Path | None:
    """series: [(model, x, y, legend text)]; reference: (x, y, text), muted and
    dashed. One chart when the models' colours can share it, otherwise one
    panel per model with the other models in grey."""
    if not series:
        return None
    names = {name for name, *_ in series}
    if len(series) == 1 or names <= OVERLAY_MODELS:
        fig, ax = _figure(title, banner)
        _grid(ax)
        ax.plot(reference[0], reference[1], color=MUTED, linewidth=1, linestyle="--", label=reference[2])
        for name, x, y, text in series:
            ax.plot(x, y, color=MODEL_COLORS.get(name, INK), linestyle=MODEL_STYLES.get(name, "-"), linewidth=2, label=text)
        ax.set(xlim=(0, 1), ylim=(0, 1.02), xlabel=xlabel, ylabel=ylabel)
        _legend(ax)
        return _save(fig, path)

    cols = 2 if len(series) == 4 else min(3, len(series))
    rows = math.ceil(len(series) / cols)
    fig, axes = plt.subplots(
        rows, cols, figsize=(3.3 * cols, 3.0 * rows + 0.9), dpi=150, sharex=True, sharey=True, squeeze=False, facecolor=SURFACE
    )
    _banner(fig, banner)
    fig.suptitle(title, x=0.02, y=0.945 if banner else 0.985, ha="left", fontsize=11, color=INK)
    for ax, (name, x, y, text) in zip(axes.flat, series):
        _style(ax)
        _grid(ax)
        ax.plot(reference[0], reference[1], color=MUTED, linewidth=1, linestyle="--")
        for other, other_x, other_y, _ in series:
            if other != name:
                ax.plot(other_x, other_y, color=AXIS, linewidth=1)
        ax.plot(x, y, color=MODEL_COLORS.get(name, INK), linestyle=MODEL_STYLES.get(name, "-"), linewidth=2)
        ax.set_title(text, fontsize=8, color=INK, loc="left")
        ax.set(xlim=(0, 1), ylim=(0, 1.02))
    for ax in axes.flat[len(series) :]:
        ax.set_visible(False)
    fig.supxlabel(xlabel, fontsize=9, color=INK_SECONDARY)
    fig.supylabel(ylabel, fontsize=9, color=INK_SECONDARY)
    fig.text(0.98, 0.005, f"Grey: the other models. Dashed: {reference[2][0].lower() + reference[2][1:]}.", ha="right", va="bottom", fontsize=7, color=INK_SECONDARY)
    return _save(fig, path, top=0.92 if banner else 0.96)


def _unpack(values):
    """(y, scores) or (y, scores, sample weights)."""
    y, scores, *rest = values
    return np.asarray(y), np.asarray(scores), (rest[0] if rest else None)


def roc_curves(curves: dict, path: Path, title: str, banner: str | None) -> Path | None:
    """curves: model -> (y_true, scores[, sample weights]). Sets with one class are skipped."""
    from sklearn.metrics import roc_auc_score, roc_curve

    series = []
    for name, values in curves.items():
        y, scores, weights = _unpack(values)
        if name == "no_skill" or not 0 < y.sum() < len(y):
            continue
        fpr, tpr, _ = roc_curve(y, scores, sample_weight=weights)
        series.append((name, fpr, tpr, f"{MODEL_LABELS.get(name, name)} (AUC {roc_auc_score(y, scores, sample_weight=weights):.2f})"))
    return _curve_chart(series, ([0, 1], [0, 1], "Chance"), path, title, banner, xlabel="False positive rate", ylabel="True positive rate (recall)")


def pr_curves(curves: dict, path: Path, title: str, banner: str | None) -> Path | None:
    from sklearn.metrics import average_precision_score, precision_recall_curve

    series, rate = [], None
    for name, values in curves.items():
        y, scores, weights = _unpack(values)
        if name == "no_skill" or not y.sum():
            continue
        rate = float(np.average(y, weights=weights))
        precision, recall, _ = precision_recall_curve(y, scores, sample_weight=weights)
        series.append((name, recall, precision, f"{MODEL_LABELS.get(name, name)} (AP {average_precision_score(y, scores, sample_weight=weights):.2f})"))
    if not series:
        return None
    return _curve_chart(series, ([0, 1], [rate, rate], f"No skill (positive rate {rate:.2f})"), path, title, banner, xlabel="Recall", ylabel="Precision")


def confusion_matrix(counts: dict, labels: tuple[str, str], path: Path, title: str, banner: str | None) -> Path:
    """counts: {"tn", "fp", "fn", "tp"} (may be trip-weighted); rows = actual, columns = predicted."""
    matrix = np.array([[counts["tn"], counts["fp"]], [counts["fn"], counts["tp"]]], dtype=float)
    fig, ax = _figure(title, banner, size=(4.8, 4.4))
    ax.imshow(matrix, cmap=BLUE_RAMP, vmin=0, vmax=max(1, matrix.max()))
    for (row, col), value in np.ndenumerate(matrix):
        dark = value > matrix.max() * 0.55
        ax.text(col, row, f"{value:g}", ha="center", va="center", fontsize=13, color="#ffffff" if dark else INK)
    ax.set_xticks([0, 1], [f"{labels[0]}", f"{labels[1]}"])
    ax.set_yticks([0, 1], [f"{labels[0]}", f"{labels[1]}"])
    ax.set(xlabel="Predicted", ylabel="Actual")
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(length=0)
    return _save(fig, path)


def training_curves(history: list[dict], metric: str, path: Path, title: str, banner: str | None, *, best_epoch: int | None = None) -> Path:
    """Training (dashed) and validation (solid) `metric` ("loss" or "accuracy")
    per epoch, in one blue hue so the categorical colours stay with the models."""
    epochs = [row["epoch"] for row in history]
    fig, ax = _figure(title, banner)
    _grid(ax)
    for set_name, text, color, style in (("train", "Training", "#5598e7", "--"), ("validation", "Validation", "#184f95", "-")):
        values = [row[f"{set_name}_{metric}"] for row in history]
        if any(v is not None for v in values):
            ax.plot(epochs, [np.nan if v is None else v for v in values], color=color, linewidth=2, linestyle=style, label=text)
    if best_epoch:
        ax.axvline(best_epoch, color=MUTED, linewidth=1, linestyle=":", label=f"Best epoch {best_epoch} (weights restored)")
    ax.set(xlabel="Epoch", ylabel=metric.capitalize())
    ax.legend(frameon=False, fontsize=8, labelcolor=INK_SECONDARY, loc="best")
    return _save(fig, path)


def feature_importance(names, values, path: Path, title: str, banner: str | None, *, xlabel: str, top: int = 15) -> Path | None:
    values = np.asarray(values, dtype=float)
    if not len(values) or not np.isfinite(values).any():
        return None
    order = np.argsort(-np.abs(np.nan_to_num(values)))[:top][::-1]
    fig, ax = _figure(title, banner, size=(6.4, 0.32 * len(order) + 1.6))
    ax.grid(True, axis="x", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.barh([names[i] for i in order], values[order], color=MODEL_COLORS["logistic_regression"], height=0.6)
    ax.axvline(0, color=AXIS, linewidth=1)
    ax.set_xlabel(xlabel)
    ax.tick_params(axis="y", labelsize=7)
    return _save(fig, path)
