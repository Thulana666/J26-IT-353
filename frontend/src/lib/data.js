import {
  articles,
  demand,
  events,
  forecasts,
  medicineImpacts,
} from "@/lib/mock-data";

// Data access for the dashboard. Each function currently returns mock data;
// replace the body with a Supabase query once the table exists, e.g.
//   const supabase = await createClient();
//   const { data } = await supabase.from("events").select("*");

export async function getEvents() {
  return [...events].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getArticles() {
  const eventTitles = Object.fromEntries(events.map((e) => [e.id, e.title]));
  return [...articles]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((article) => ({ ...article, eventTitle: eventTitles[article.eventId] }));
}

export async function getMedicineImpacts() {
  const eventTitles = Object.fromEntries(events.map((e) => [e.id, e.title]));
  return medicineImpacts
    .map((impact) => ({ ...impact, eventTitle: eventTitles[impact.eventId] }))
    .sort((a, b) => Math.abs(b.expectedChangePct) - Math.abs(a.expectedChangePct));
}

export async function getDemand() {
  return demand.map((row) => ({
    ...row,
    changePct: Math.round(((row.last30Days - row.baseline) / row.baseline) * 100),
  }));
}

export async function getForecasts() {
  return forecasts.map((row) => {
    const total = row.weeks.reduce((sum, value) => sum + value, 0);
    const baselineTotal = row.weeklyBaseline * row.weeks.length;
    return {
      ...row,
      total,
      changePct: Math.round(((total - baselineTotal) / baselineTotal) * 100),
    };
  });
}
