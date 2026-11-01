import { llmsFullTxt } from "@/lib/markdown/llms";
import { markdownResponse } from "@/lib/markdown/response";

// Includes the download page's release, refreshed like the page's.
export const revalidate = 600;

export async function GET() {
  return markdownResponse(await llmsFullTxt(), { plainText: true });
}
