// Demand forecast providers.
//
// The rest of the analytics (stock cover, Q*, alerts) only depends on this
// interface, so another provider (for example an HTTP call to the Python
// ai-service) can replace these without other changes:
//
//   forecast({ series: [{ id, days }], horizonDays, windowDays })
//     -> [{ id, model, level, forecast: number[horizonDays], residualSd, burn }]
//
// moving_average:    the transparent baseline (burn rate of the last window).
// linear_regression: the pooled model of linear-regression.js, trained during a
//                    recalculation (service.trainDemandModel). It is used only
//                    for products where it beat the moving average on the
//                    held-out days; every other product, and any product whose
//                    recent history cannot support it, uses the moving average.

const { mean } = require("./stats");
const { movingAverageForecast } = require("./demand");
const { forecastRecursive } = require("./linear-regression");

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

// model: the trained model as stored in a run's summary.model.
function linearRegression(model) {
  return {
    engine: "linear_regression",
    model: "linear_regression",
    label: "linear regression",
    forecast(args) {
      const baseline = movingAverage.forecast(args);
      return baseline.map((ma, i) => {
        const choice = model.perProduct?.[ma.id];
        if (!choice?.selected) return ma;
        const forecast = forecastRecursive(model.coefficients, args.series[i].days, args.horizonDays);
        if (!forecast) return ma;
        return { id: ma.id, model: "linear_regression", level: mean(forecast), forecast, residualSd: choice.residualSd ?? ma.residualSd, burn: ma.burn };
      });
    },
  };
}

const usable = (model) => Boolean(model?.method === "linear_regression" && Array.isArray(model.coefficients) && model.coefficients.every(Number.isFinite));

function getProvider(model = null) {
  return usable(model) ? linearRegression(model) : movingAverage;
}

module.exports = { getProvider, movingAverage, linearRegression };
