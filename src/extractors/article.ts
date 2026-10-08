import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Extractor } from "../types.js";

// The registry iterates extractors in order, so this catch-all only fires
// after youtube/x/paper have all said no.
const article: Extractor<"article"> = {
  source: "article",

  matches(url: string): boolean {
    return /^https?:\/\//i.test(url);
  },

  extractId(url: string): string {
    return createHash("sha256").update(url.trim()).digest("hex").slice(0, 16);
  },

  async fetch(url: string, signal: AbortSignal) {
    const res = await fetch(url, {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Fetch returned ${res.status} for ${url}`);
    const html = await res.text();

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) {
      throw new Error("Readability could not extract a readable article from this page");
    }

    const title = (article.title || url).trim();
    const body = (article.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) throw new Error("Readability returned empty body");

    return {
      title,
      content: body,
      source_specific: {
        byline: article.byline ?? null,
        siteName: article.siteName ?? null,
        excerpt: article.excerpt ?? null,
        lang: article.lang ?? null,
        length: article.length ?? body.length,
        publishedTime: (article as any).publishedTime ?? null,
      },
      raw: { contentHtml: article.content },
    };
  },
};

export default article;
