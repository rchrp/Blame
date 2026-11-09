import { loadServiceStatus } from "@/lib/service-status";

// The footer's status dot reads this route. It is rebuilt at most once a
// minute, so the status page is read at most once a minute too.
export const revalidate = 60;

export async function GET() {
  return Response.json({ status: await loadServiceStatus() });
}
