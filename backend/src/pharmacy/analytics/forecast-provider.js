// Demand forecast providers.
//
// The pharmacy uses a transparent moving average. The rest of the analytics
// (stock cover, Q*, alerts) only depends on this interface, so a future ML
// provider (for example an HTTP call to the Python ai-service) can replace it
// without other changes:
//
//   forecast({ series: [{ id, days }], horizonDays, windowDays })
//     -> [{ id, model, level, forecast: number[horizonDays], residualSd, burn }]
//
// Only the moving average is implemented; no model is trained here.

const { movingAverageForecast } = require("./demand");

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

function getProvider() {
  return movingAverage;
}

module.exports = { getProvider, movingAverage };
