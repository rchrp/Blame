import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { downloadWebPage, publicWebUrl } from "./web-research-network.js";
import type {
  RenderWebPage,
  WebPageResult,
  WebSource,
} from "./web-research-types.js";

export function webSource(url: string): WebSource {
  const normalized = publicWebUrl(url);
  return {
    id: `web_${createHash("sha256").update(normalized.href).digest("hex").slice(0, 24)}`,
    url: normalized.href,
    domain: normalized.hostname,
    title: normalized.hostname,
    snippet: "",
    retrievedAt: new Date().toISOString(),
  };
}

export function extractWebPage(
  html: string,
  finalUrl: string,
  originalUrl = finalUrl,
  method: WebPageResult["method"] = "readability",
): WebPageResult {
  const source = { ...webSource(originalUrl), finalUrl };
  // jsdom does not run scripts or load subresources. Only plain text leaves the reader.
  const dom = new JSDOM(html, {
    url: finalUrl,
    virtualConsole: new VirtualConsole(),
  });
  try {
    const document = dom.window.document;
    const title = document.title;
    const article = new Readability(document.cloneNode(true) as Document, {
      charThreshold: 100,
      maxElemsToParse: 50_000,
    }).parse();
    document
      .querySelectorAll("script,style,noscript,nav,footer,header,form,svg")
      .forEach((node) => node.remove());
    const content = (
      article?.textContent ||
      document.querySelector("main")?.textContent ||
      document.body?.textContent ||
      ""
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n/g, "\n\n")
      .trim();
    const published = article?.publishedTime;
    return {
      source: {
        ...source,
        title: article?.title || title || source.domain,
        snippet: (article?.excerpt || content).slice(0, 700),
        ...(article?.byline ? { author: article.byline } : {}),
        ...(article?.siteName ? { siteName: article.siteName } : {}),
        ...(published && Number.isFinite(Date.parse(published))
          ? { publishedAt: new Date(published).toISOString() }
          : {}),
      },
      content: content.slice(0, 50_000),
      status: content.length >= 140 ? "read" : "partial",
      method,
      truncated: content.length > 50_000,
    };
  } finally {
    dom.window.close();
  }
}

export async function readWebPage(
  url: string,
  options: {
    signal?: AbortSignal;
    render?: RenderWebPage;
    mode?: "auto" | "browser" | "http";
    download?: typeof downloadWebPage;
  } = {},
): Promise<WebPageResult> {
  const source = webSource(url);
  const signal = AbortSignal.any([
    AbortSignal.timeout(35_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let result: WebPageResult | undefined;
  try {
    if (options.mode !== "browser") {
      const page = await (options.download ?? downloadWebPage)(url, signal);
      result = /html/i.test(page.contentType)
        ? extractWebPage(page.body, page.url, url)
        : {
            source: {
              ...source,
              finalUrl: page.url,
              snippet: page.body.slice(0, 700),
            },
            content: page.body.slice(0, 50_000),
            status: page.body.trim() ? "read" : "partial",
            method: "text",
            truncated: page.body.length > 50_000,
          };
    }
    if (
      options.mode !== "http" &&
      (!result || result.status === "partial") &&
      options.render
    ) {
      try {
        const rendered = await options.render({ url, signal });
        const next = extractWebPage(
          rendered.html,
          rendered.url,
          url,
          "electron",
        );
        if (!result || next.content.length >= result.content.length)
          result = next;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!result) throw error;
        result.error = `Browser rendering unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!result)
      throw new Error("Browser rendering is unavailable on this runtime.");
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    return {
      source,
      content: "",
      status: "failed",
      method: options.mode === "browser" ? "electron" : "readability",
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
