"""Component 4 (pharmacy): next-day demand model trained with scikit-learn.

The Node.js backend sends each product's daily sales series; this package
builds the features, evaluates a ridge linear regression against the 28-day
moving average on held-out days, decides per product which method to use, and
forecasts the next days of every product. The backend stores the result with
its forecast run and uses the forecasts; it does no model computation itself.
"""
