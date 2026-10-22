// Demand forecast providers.
//
// The rest of the analytics (stock cover, Q*, alerts) only depends on this
// interface:
//
//   forecast({ series: [{ id, days }], horizonDays, windowDays })
//     -> [{ id, model, level, forecast: number[horizonDays], residualSd, burn }]
//
// moving_average:    the transparent baseline (burn rate of the last window),
//                    computed here.
// linear_regression: forecasts made by the Python AI service (scikit-learn,
//                    ai-service/pharmacy_demand) during the latest
//                    recalculation and stored with that run; nothing is
//                    computed here. Used only for products where the model beat
//                    the moving average on held-out days. A product without a
//                    stored forecast, or whose forecast is more than
//                    MAX_FORECAST_AGE_DAYS old, uses the moving average.

const { mean } = require("./stats");
const { movingAverageForecast } = require("./demand");
const { today, daysBetween } = require("../dates");

// After this many days without a recalculation, the stored forecast is not used.
const MAX_FORECAST_AGE_DAYS = 7;

const movingAverage = {
  engine: "moving_average",
  model: "moving_average",
  label: "moving average",
  forecast({ series, horizonDays, windowDays }) {
    return series.map(({ id, days }) => {
      const ma = movingAverageForecast(days, { window: windowDays, horizon: horizonDays });
      return { id, model: "moving_average", level: ma.level, forecast: ma.forecast, residualSd: ma.residualSd, burn: ma.burn };
    });
  },
};

// The stored forecast from today on, `horizonDays` long, or null when it is
// missing or too old. Days already past are dropped; a shortfall at the end is
// filled with the average of the remaining days.
function alignForecast(stored, horizonDays, todayISO) {
  if (!stored?.start || !Array.isArray(stored.values)) return null;
  const elapsed = daysBetween(stored.start, todayISO);
  if (elapsed > MAX_FORECAST_AGE_DAYS) return null;
  const values = stored.values.slice(Math.max(0, elapsed));
  if (values.length === 0) return null;
  const fill = mean(values);
  return Array.from({ length: horizonDays }, (_, i) => values[i] ?? fill);
}

// model: the trained model as stored in a run's summary.model.
function linearRegression(model, todayISO = today()) {
  return {
    engine: "linear_regression",
    model: "linear_regression",
    label: "linear regression",
    forecast(args) {
      return movingAverage.forecast(args).map((ma) => {
        const choice = model.perProduct?.[ma.id];
        if (!choice?.selected) return ma;
        const forecast = alignForecast(model.forecasts?.[ma.id], args.horizonDays, todayISO);
        if (!forecast) return ma;
        return { id: ma.id, model: "linear_regression", level: mean(forecast), forecast, residualSd: choice.residualSd ?? ma.residualSd, burn: ma.burn };
      });
    },
  };
}

const usable = (model) => Boolean(model?.method === "linear_regression" && model.forecasts && typeof model.forecasts === "object");

function getProvider(model = null) {
  return usable(model) ? linearRegression(model) : movingAverage;
}

module.exports = { MAX_FORECAST_AGE_DAYS, alignForecast, getProvider, movingAverage, linearRegression };
