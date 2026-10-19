"""Shared preprocessing for the cold-chain models (Component 2).

Pure Python (standard library only), so the AI service, the dataset builder
and the tests run exactly the same code; training and inference cannot drift.

  clean_readings  sort, drop duplicates, remove invalid values, keep the trip
                  period. Every change is counted in a CleaningReport: bad
                  data is never adjusted silently, only removed and reported.
  build_grid      puts a trip on a fixed time grid (default 1 minute) and
                  computes the features. Each grid step only uses readings
                  taken before its end time (no look-ahead, no leakage).
  sequence_at     the last `steps` grid rows: input of the CNN-LSTM
                  (temperature-excursion model), left-padded at the trip start.
  delay_features  trip-progress snapshot: input of the delivery-delay model.
  Scaler          standardisation fitted on the training split only and saved
                  with the model; missing values become the training mean.

Missing values are None. They are never invented: the scaler imputes the
training mean and the binary columns (observed, eta_known, ...) tell the model
which values were measured. Raw coordinates are not features; movement is
described by distance travelled, distance to the destination and speed.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

SRI_LANKA = timezone(timedelta(hours=5, minutes=30))

# Physically valid sensor values (the database checks the same ranges).
VALID_RANGES = {
    "temperature_c": (-60.0, 85.0),
    "humidity_pct": (0.0, 100.0),
    "latitude": (-90.0, 90.0),
    "longitude": (-180.0, 180.0),
    "speed_kmh": (0.0, 250.0),
}

# CNN-LSTM input, one row per grid step.
SEQUENCE_FEATURES = (
    "temperature_c",
    "temperature_pos",  # 0 = lower limit, 1 = upper limit
    "margin_to_limit_c",  # distance to the nearest limit; negative = outside
    "temperature_change_c",  # since the previous step
    "temperature_roll_mean_c",
    "temperature_roll_std_c",
    "temperature_roll_slope_c_per_min",
    "humidity_pct",
    "humidity_change_pct",
    "humidity_roll_mean_pct",
    "humidity_roll_std_pct",
    "speed_kmh",
    "speed_change_kmh",
    "speed_roll_mean_kmh",
    "minutes_stopped",  # current stop so far
    "hour_sin",  # local time of day (Sri Lanka), cyclic
    "hour_cos",
    "elapsed_minutes",  # since the trip started
    "distance_travelled_km",
    "km_to_destination",  # straight line from the last valid position
    "minutes_to_eta",  # planned delivery time minus now (negative = overdue)
    "minutes_since_reading",  # how stale the carried-forward values are
    "observed",  # 1 if a reading arrived in this step
    "gps_jump",  # 1 if a reading in this step was flagged as a GPS jump
    "in_trip",  # 0 only for padding before the trip started
    "eta_known",
    "destination_known",
)
FEATURES = SEQUENCE_FEATURES
BINARY_FEATURES = frozenset({"observed", "gps_jump", "in_trip", "eta_known", "destination_known"})

# Delivery-delay model input, one row per snapshot.
DELAY_FEATURES = (
    "elapsed_minutes",
    "planned_minutes",  # planned trip duration (start -> planned delivery)
    "elapsed_fraction",
    "minutes_to_eta",
    "distance_travelled_km",
    "km_to_destination",
    "planned_km",  # straight line origin -> destination
    "progress_fraction",
    "avg_speed_kmh",  # distance travelled / elapsed time
    "recent_speed_kmh",
    "required_speed_kmh",  # straight-line distance left / time left
    "minutes_stopped",
    "stopped_minutes_total",
    "missing_data_fraction",  # grid steps without a reading so far
    "gps_jumps",
    "hour_sin",
    "hour_cos",
    "is_weekend",
)
DELAY_BINARY_FEATURES = frozenset({"is_weekend"})


@dataclass(frozen=True)
class Reading:
    recorded_at: datetime
    temperature_c: float | None = None
    humidity_pct: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    speed_kmh: float | None = None
    gps_jump: bool = False


@dataclass(frozen=True)
class TripContext:
    """What is known about a trip when it starts (never its outcome)."""

    temp_min_c: float
    temp_max_c: float
    started_at: datetime
    expected_delivery_at: datetime | None = None
    destination: tuple[float, float] | None = None
    origin: tuple[float, float] | None = None

    def __post_init__(self):
        if self.temp_max_c <= self.temp_min_c:
            raise ValueError("temp_max_c must be above temp_min_c")
        _require_tz(self.started_at)


@dataclass(frozen=True)
class GridConfig:
    step_seconds: int = 60
    roll_steps: int = 10  # rolling statistics over the last 10 steps
    stop_speed_kmh: float = 2.0  # below this the truck counts as stopped
    max_staleness_minutes: float = 60.0  # cap for minutes_since_reading

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CleaningReport:
    input: int = 0
    duplicates: int = 0  # same recorded_at as an earlier reading
    outside_trip: int = 0  # before the start or after the end of the trip
    invalid: dict[str, int] = field(default_factory=dict)  # values outside VALID_RANGES / not finite
    incomplete_position: int = 0  # latitude without longitude or the reverse
    no_gps_fix: int = 0  # 0, 0 positions
    gps_jumps: int = 0  # flagged by the backend; position not used for movement
    empty: int = 0  # no valid measurement left
    output: int = 0

    def add(self, other: CleaningReport) -> None:
        for name in ("input", "duplicates", "outside_trip", "incomplete_position", "no_gps_fix", "gps_jumps", "empty", "output"):
            setattr(self, name, getattr(self, name) + getattr(other, name))
        for name, count in other.invalid.items():
            self.invalid[name] = self.invalid.get(name, 0) + count

    def to_dict(self) -> dict:
        return asdict(self)


def _require_tz(value: datetime) -> None:
    if value.tzinfo is None:
        raise ValueError("timestamps must include a time zone")


def parse_time(value: str | None) -> datetime | None:
    """ISO 8601 with a time zone (as exported by Supabase) -> aware datetime."""
    if value in (None, ""):
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require_tz(parsed)
    return parsed


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    h = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    return 2 * 6371 * math.asin(min(1.0, math.sqrt(h)))


def clean_readings(
    readings: list[Reading], *, start: datetime | None = None, end: datetime | None = None
) -> tuple[list[Reading], CleaningReport]:
    """Readings sorted by time, without duplicates, invalid values or readings
    outside [start, end]. Invalid values become None; a reading with no valid
    value left is dropped. The report counts every change."""
    report = CleaningReport(input=len(readings))
    seen: set[datetime] = set()
    cleaned: list[Reading] = []
    for reading in sorted(readings, key=lambda r: r.recorded_at):
        _require_tz(reading.recorded_at)
        if reading.recorded_at in seen:
            report.duplicates += 1
            continue
        seen.add(reading.recorded_at)
        if (start and reading.recorded_at < start) or (end and reading.recorded_at > end):
            report.outside_trip += 1
            continue
        values = {name: getattr(reading, name) for name in VALID_RANGES}
        for name, (low, high) in VALID_RANGES.items():
            value = values[name]
            if value is not None and not (math.isfinite(value) and low <= value <= high):
                values[name] = None
                report.invalid[name] = report.invalid.get(name, 0) + 1
        if (values["latitude"] is None) != (values["longitude"] is None):
            values["latitude"] = values["longitude"] = None
            report.incomplete_position += 1
        elif values["latitude"] == 0 and values["longitude"] == 0:
            values["latitude"] = values["longitude"] = None
            report.no_gps_fix += 1
        if reading.gps_jump:
            report.gps_jumps += 1
        if all(value is None for value in values.values()):
            report.empty += 1
            continue
        cleaned.append(Reading(reading.recorded_at, gps_jump=reading.gps_jump, **values))
    report.output = len(cleaned)
    return cleaned, report


def _rolling(values: list[float]) -> tuple[float | None, float | None, float | None]:
    """Mean, population std and least-squares slope (per step) of the known values."""
    known = [(i, v) for i, v in enumerate(values) if v is not None]
    if not known:
        return None, None, None
    n = len(known)
    mean = sum(v for _, v in known) / n
    std = math.sqrt(sum((v - mean) ** 2 for _, v in known) / n)
    if n < 2:
        return mean, std, None
    mean_x = sum(i for i, _ in known) / n
    sxx = sum((i - mean_x) ** 2 for i, _ in known)
    slope = sum((i - mean_x) * (v - mean) for i, v in known) / sxx
    return mean, std, slope


def _diff(current: float | None, previous: float | None) -> float | None:
    return current - previous if current is not None and previous is not None else None


def build_grid(readings: list[Reading], trip: TripContext, *, until: datetime, config: GridConfig = GridConfig()) -> list[dict]:
    """One dict per grid step from the trip start to `until`, oldest first.

    Step i ends at started_at + (i + 1) x step and uses only readings taken
    before that time. `readings` must be cleaned (sorted). Values are carried
    forward between readings; keys starting with "_" are running totals used
    by delay_features, not model inputs."""
    step = timedelta(seconds=config.step_seconds)
    step_minutes = config.step_seconds / 60
    count = max(0, int((until - trip.started_at) / step))
    span = trip.temp_max_c - trip.temp_min_c
    state = {"temperature": None, "humidity": None, "speed": None, "lat": None, "lon": None, "last": None}
    history = {"temperature": [], "humidity": [], "speed": []}
    distance = stop_run = stopped_total = 0.0
    jumps_total = observed_total = 0
    index = 0
    rows: list[dict] = []
    for i in range(count):
        time = trip.started_at + (i + 1) * step
        observed = jump = 0
        while index < len(readings) and readings[index].recorded_at < time:
            reading = readings[index]
            index += 1
            observed = 1
            state["last"] = reading.recorded_at
            for key, value in (("temperature", reading.temperature_c), ("humidity", reading.humidity_pct), ("speed", reading.speed_kmh)):
                if value is not None:
                    state[key] = value
            if reading.gps_jump:
                jump = 1
            elif reading.latitude is not None:
                if state["lat"] is not None:
                    distance += haversine_km(state["lat"], state["lon"], reading.latitude, reading.longitude)
                state["lat"], state["lon"] = reading.latitude, reading.longitude
        observed_total += observed
        jumps_total += jump

        previous = {key: (values[-1] if values else None) for key, values in history.items()}
        for key in history:
            history[key].append(state[key])
            del history[key][: -config.roll_steps]
        temperature, humidity, speed = state["temperature"], state["humidity"], state["speed"]
        t_mean, t_std, t_slope = _rolling(history["temperature"])
        h_mean, h_std, _ = _rolling(history["humidity"])
        s_mean, _, _ = _rolling(history["speed"])
        if speed is not None and speed < config.stop_speed_kmh:
            stop_run += step_minutes
            stopped_total += step_minutes
        elif speed is not None:
            stop_run = 0.0

        local = time.astimezone(SRI_LANKA)
        hour = local.hour + local.minute / 60
        elapsed = (i + 1) * step_minutes
        since = (time - state["last"]).total_seconds() / 60 if state["last"] else elapsed
        position = state["lat"] is not None
        rows.append(
            {
                "temperature_c": temperature,
                "temperature_pos": (temperature - trip.temp_min_c) / span if temperature is not None else None,
                "margin_to_limit_c": min(temperature - trip.temp_min_c, trip.temp_max_c - temperature) if temperature is not None else None,
                "temperature_change_c": _diff(temperature, previous["temperature"]),
                "temperature_roll_mean_c": t_mean,
                "temperature_roll_std_c": t_std,
                "temperature_roll_slope_c_per_min": t_slope / step_minutes if t_slope is not None else None,
                "humidity_pct": humidity,
                "humidity_change_pct": _diff(humidity, previous["humidity"]),
                "humidity_roll_mean_pct": h_mean,
                "humidity_roll_std_pct": h_std,
                "speed_kmh": speed,
                "speed_change_kmh": _diff(speed, previous["speed"]),
                "speed_roll_mean_kmh": s_mean,
                "minutes_stopped": stop_run,
                "hour_sin": math.sin(2 * math.pi * hour / 24),
                "hour_cos": math.cos(2 * math.pi * hour / 24),
                "elapsed_minutes": elapsed,
                "distance_travelled_km": distance,
                "km_to_destination": (
                    haversine_km(state["lat"], state["lon"], *trip.destination) if trip.destination and position else None
                ),
                "minutes_to_eta": (trip.expected_delivery_at - time).total_seconds() / 60 if trip.expected_delivery_at else None,
                "minutes_since_reading": min(config.max_staleness_minutes, since),
                "observed": float(observed),
                "gps_jump": float(jump),
                "in_trip": 1.0,
                "eta_known": float(trip.expected_delivery_at is not None),
                "destination_known": float(trip.destination is not None),
                "_time": time,
                "_stopped_total": stopped_total,
                "_jumps_total": jumps_total,
                "_observed_total": observed_total,
            }
        )
    return rows


def padding_row() -> list[float | None]:
    """A sequence row before the trip started: binary columns 0, the rest missing."""
    return [0.0 if name in BINARY_FEATURES else None for name in SEQUENCE_FEATURES]


def sequence_at(grid: list[dict], index: int, steps: int) -> list[list[float | None]]:
    """The `steps` grid rows ending at `index` (oldest first), left-padded."""
    rows = grid[max(0, index - steps + 1) : index + 1]
    return [padding_row() for _ in range(steps - len(rows))] + [[row[name] for name in SEQUENCE_FEATURES] for row in rows]


def delay_features(grid: list[dict], index: int, trip: TripContext) -> list[float | None]:
    """Trip progress at grid step `index`, in DELAY_FEATURES order."""
    row = grid[index]
    elapsed = row["elapsed_minutes"]
    planned = (trip.expected_delivery_at - trip.started_at).total_seconds() / 60 if trip.expected_delivery_at else None
    to_eta = row["minutes_to_eta"]
    remaining_km = row["km_to_destination"]
    planned_km = haversine_km(*trip.origin, *trip.destination) if trip.origin and trip.destination else None
    local = row["_time"].astimezone(SRI_LANKA)
    values = {
        "elapsed_minutes": elapsed,
        "planned_minutes": planned,
        "elapsed_fraction": elapsed / planned if planned else None,
        "minutes_to_eta": to_eta,
        "distance_travelled_km": row["distance_travelled_km"],
        "km_to_destination": remaining_km,
        "planned_km": planned_km,
        "progress_fraction": 1 - remaining_km / planned_km if planned_km and remaining_km is not None else None,
        "avg_speed_kmh": row["distance_travelled_km"] / (elapsed / 60) if elapsed > 0 else None,
        "recent_speed_kmh": row["speed_roll_mean_kmh"],
        "required_speed_kmh": remaining_km / (to_eta / 60) if remaining_km is not None and to_eta and to_eta > 0 else None,
        "minutes_stopped": row["minutes_stopped"],
        "stopped_minutes_total": row["_stopped_total"],
        "missing_data_fraction": 1 - row["_observed_total"] / (index + 1),
        "gps_jumps": float(row["_jumps_total"]),
        "hour_sin": row["hour_sin"],
        "hour_cos": row["hour_cos"],
        "is_weekend": float(local.weekday() >= 5),
    }
    return [values[name] for name in DELAY_FEATURES]


def _missing(value) -> bool:
    return value is None or value != value  # None or NaN (also numpy NaN)


# Tabular summary of a CNN-LSTM input window for the baseline models (logistic
# regression, random forest, gradient boosting): the latest row plus window
# statistics, so baselines and the CNN-LSTM see the same information.
SUMMARY_SOURCES = ("temperature_c", "margin_to_limit_c", "humidity_pct", "speed_kmh")
SUMMARY_STATS = ("mean", "std", "min", "max", "slope_per_step")
SUMMARY_FEATURES = (
    tuple(f"last_{name}" for name in SEQUENCE_FEATURES)
    + tuple(f"window_{stat}_{name}" for name in SUMMARY_SOURCES for stat in SUMMARY_STATS)
    + ("window_observed_fraction", "window_gps_jumps", "window_history_fraction")
)
SUMMARY_BINARY_FEATURES = frozenset(f"last_{name}" for name in BINARY_FEATURES)


def window_summary(sequence) -> list[float | None]:
    """SUMMARY_FEATURES for one sequence (rows in SEQUENCE_FEATURES order,
    unscaled; None or NaN = missing). Padding rows are ignored."""
    in_trip = SEQUENCE_FEATURES.index("in_trip")
    rows = [row for row in sequence if not _missing(row[in_trip]) and row[in_trip] == 1]
    values = [None if _missing(v) else float(v) for v in sequence[-1]]
    for name in SUMMARY_SOURCES:
        j = SEQUENCE_FEATURES.index(name)
        series = [None if _missing(row[j]) else float(row[j]) for row in rows]
        known = [v for v in series if v is not None]
        mean, std, slope = _rolling(series)
        values += [mean, std, min(known, default=None), max(known, default=None), slope]
    observed, jumps = SEQUENCE_FEATURES.index("observed"), SEQUENCE_FEATURES.index("gps_jump")
    values += [
        sum(float(row[observed]) for row in rows) / len(rows) if rows else None,
        sum(float(row[jumps]) for row in rows),
        len(rows) / len(sequence),
    ]
    return values


@dataclass
class Scaler:
    """Standardisation ((x - mean) / std) fitted on training rows only.

    Binary columns are left as they are. Missing values (None/NaN) become 0
    after scaling, i.e. the training mean. Saved with the model (to_dict)."""

    features: tuple[str, ...]
    mean: list[float]
    std: list[float]
    scaled: list[bool]

    @classmethod
    def fit(cls, rows, features: tuple[str, ...], binary: frozenset[str] = frozenset()) -> Scaler:
        sums = [0.0] * len(features)
        squares = [0.0] * len(features)
        counts = [0] * len(features)
        for row in rows:
            for j, value in enumerate(row):
                if not _missing(value):
                    value = float(value)
                    sums[j] += value
                    squares[j] += value * value
                    counts[j] += 1
        mean, std, scaled = [], [], []
        for j, name in enumerate(features):
            is_scaled = name not in binary and counts[j] > 0
            m = sums[j] / counts[j] if is_scaled else 0.0
            variance = squares[j] / counts[j] - m * m if is_scaled else 1.0
            s = math.sqrt(variance) if variance > 1e-12 else 1.0
            mean.append(m)
            std.append(s)
            scaled.append(is_scaled)
        return cls(tuple(features), mean, std, scaled)

    def transform_row(self, row) -> list[float]:
        return [
            0.0 if _missing(value) else (float(value) - self.mean[j]) / self.std[j] if self.scaled[j] else float(value)
            for j, value in enumerate(row)
        ]

    def transform(self, rows) -> list[list[float]]:
        return [self.transform_row(row) for row in rows]

    def transform_array(self, array):
        """Same transformation on a numpy array whose last axis is the features."""
        import numpy as np

        mean = np.where(self.scaled, self.mean, 0.0)
        std = np.where(self.scaled, self.std, 1.0)
        return np.nan_to_num((np.asarray(array, dtype=np.float64) - mean) / std, nan=0.0).astype(np.float32)

    def to_dict(self) -> dict:
        return {"features": list(self.features), "mean": self.mean, "std": self.std, "scaled": self.scaled}

    @classmethod
    def from_dict(cls, data: dict) -> Scaler:
        return cls(tuple(data["features"]), list(data["mean"]), list(data["std"]), list(data["scaled"]))
