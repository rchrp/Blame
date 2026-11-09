// Better Stack watches blame.so, its API and its downloads, and publishes
// the result on this status page.
export const statusPageUrl = "https://blame-ade.betteruptime.com/";

const statusDataUrl = new URL("index.json", statusPageUrl).toString();
const revalidateSeconds = 60;

const serviceStatuses = [
  "operational",
  "degraded",
  "downtime",
  "maintenance",
] as const;

// "unknown" when the status page can't be read.
export type ServiceStatus = (typeof serviceStatuses)[number] | "unknown";

export function isServiceStatus(value: unknown): value is ServiceStatus {
  return (
    value === "unknown" ||
    serviceStatuses.includes(value as (typeof serviceStatuses)[number])
  );
}

// Read on the server and cached for a minute (app/api/status), so visitors
// never call Better Stack themselves.
export async function loadServiceStatus(): Promise<ServiceStatus> {
  try {
    const response = await fetch(statusDataUrl, {
      next: { revalidate: revalidateSeconds },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return "unknown";

    const page = (await response.json()) as {
      data?: { attributes?: { aggregate_state?: unknown } };
    };
    const status = page.data?.attributes?.aggregate_state;
    return isServiceStatus(status) ? status : "unknown";
  } catch {
    return "unknown";
  }
}
