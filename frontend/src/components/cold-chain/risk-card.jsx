import { LevelBadge } from "@/components/dashboard/status-badges";
import { PrototypeBadge, ToneBadge } from "@/components/cold-chain/badges";
import { DefinitionList, EmptyState } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RISK_TYPES, formatDateTime, formatDuration, formatPercent } from "@/lib/cold-chain/format";

// Predicted risk of the shipment. A prediction states a probability of a
// potential problem, never that a product is spoiled. Until a predictor runs,
// the card says so instead of showing a placeholder number.
export function RiskCard({ prediction, error }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Predicted risk</CardTitle>
        <CardDescription>Probability of a cold-chain or logistics problem in the coming period, from the sensor history.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && !prediction && (
          <EmptyState title="No risk prediction yet">
            The temporary prototype predictor is added in the next step; the trained CNN-LSTM model replaces it later. Alerts
            below are measured limit crossings, not predictions.
          </EmptyState>
        )}
        {prediction && (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <p className="text-xs text-muted-foreground">Overall risk</p>
                <div className="mt-1">
                  <LevelBadge level={prediction.riskLevel} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Risk probability</p>
                <p className="text-3xl font-semibold">{formatPercent(prediction.riskProbability)}</p>
              </div>
              {prediction.isPrototype ? <PrototypeBadge /> : <ToneBadge tone="blue">Trained model</ToneBadge>}
            </div>
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">{prediction.riskType ? `Main risk: ${RISK_TYPES[prediction.riskType] ?? prediction.riskType}` : "No dominant risk"}</p>
              <p className="mt-1 text-muted-foreground">{prediction.explanation}</p>
            </div>
            <DefinitionList
              items={[
                ["Model", `${prediction.modelName} ${prediction.modelVersion}`],
                ["Predicted", formatDateTime(prediction.predictedAt)],
                ["Looks ahead", formatDuration(prediction.horizonMinutes)],
                ["Based on", `${prediction.readingsUsed} reading(s) up to ${formatDateTime(prediction.dataUntil)}`],
              ]}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
