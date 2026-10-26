/** Persisted in tool results; usable by the chat without loading the runtime. */
export type WebSource = {
  id: string;
  url: string;
  title: string;
  domain: string;
  snippet: string;
  retrievedAt: string;
  engines?: string[];
  publishedAt?: string;
  finalUrl?: string;
  author?: string;
  siteName?: string;
};

export type WebSearchResult = {
  query: string;
  sources: WebSource[];
  resultCount: number;
  partial: boolean;
  unavailableEngines: string[];
  retrievedAt: string;
};

export type WebPageResult = {
  source: WebSource;
  content: string;
  status: "read" | "partial" | "failed";
  method: "readability" | "electron" | "text";
  truncated: boolean;
  error?: string;
};

export type RenderWebPage = (input: {
  url: string;
  signal?: AbortSignal;
}) => Promise<{ url: string; html: string }>;
