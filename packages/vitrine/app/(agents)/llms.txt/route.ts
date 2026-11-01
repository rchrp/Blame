import { llmsTxt } from "@/lib/markdown/llms";
import { markdownResponse } from "@/lib/markdown/response";

export const dynamic = "force-static";

export function GET() {
  return markdownResponse(llmsTxt(), { plainText: true });
}
