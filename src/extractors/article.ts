import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Extractor } from "../types.js";
import {
  mediaSection,
  mediaSummary,
  pruneMediaDir,
  resetMediaDir,
  saveImage,
  type MediaFile,
} from "../lib/media.js";

const MAX_ARTICLE_IMAGES = 8;
// Smaller than this is an icon, an avatar or a tracking pixel, not a figure.
const MIN_ARTICLE_IMAGE_BYTES = 12 * 1024;

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

  async fetch(url: string, signal: AbortSignal, options?: Record<string, unknown>) {
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
    // Read before Readability runs: it rewrites the document it parses.
    const lead = dom.window.document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) {
      throw new Error("Readability could not extract a readable article from this page");
    }

    const title = (article.title || url).trim();
    const body = (article.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) throw new Error("Readability returned empty body");

    // The lead image and the figures inside the article body.
    const media: MediaFile[] = [];
    if (options?.downloadMedia !== false) {
      const inBody = Array.from(new JSDOM(article.content || "", { url }).window.document.querySelectorAll("img"))
        .map((img) => img.src)
        .filter((src) => /^https?:\/\//i.test(src));
      const links = [...new Set([lead, ...inBody].filter(Boolean).map((src) => new URL(src, url).toString()))];
      const dir = await resetMediaDir("article", this.extractId(url));
      for (const link of links) {
        if (media.length >= MAX_ARTICLE_IMAGES) break;
        const image = await saveImage(link, dir, `image_${media.length + 1}`, signal, MIN_ARTICLE_IMAGE_BYTES);
        if (image) media.push(image);
      }
      await pruneMediaDir(dir);
    }
    const listed = mediaSection(media);

    return {
      title,
      content: listed ? `${body}\n\n${listed}` : body,
      source_specific: {
        ...mediaSummary(media),
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
