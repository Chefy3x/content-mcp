import type { Extractor } from "../types.js";
import { fetchShortVideo } from "../lib/short-video.js";

const POST = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// A photo post has no video for yt-dlp to read. Instagram still serves the
// caption in its link-preview tags, but only to a preview crawler.
async function previewCaption(url: string, signal: AbortSignal) {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "facebookexternalhit/1.1", "Accept-Language": "en" },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const tag = (name: string) =>
    html.match(new RegExp(`<meta[^>]+property="og:${name}"[^>]*content="([^"]*)"`, "i"))?.[1];
  const description = decode(tag("description") || "");
  const title = decode(tag("title") || "");
  if (!description && !title) return null;
  // og:title reads `Name on Instagram: "caption"`.
  const author = title.match(/^(.*?) on Instagram/)?.[1];
  return { author, caption: description || title, image: decode(tag("image") || "") || undefined };
}

const instagram: Extractor<"instagram"> = {
  source: "instagram",

  matches(url: string): boolean {
    return POST.test(url);
  },

  extractId(url: string): string {
    const m = url.match(POST);
    if (!m) throw new Error("Could not extract Instagram shortcode from URL");
    return m[1];
  },

  fetch(url: string, signal: AbortSignal, options?: Record<string, unknown>) {
    return fetchShortVideo(url, signal, options, {
      platform: "Instagram",
      source: "instagram",
      id: this.extractId(url),
      fallback: previewCaption,
    });
  },
};

export default instagram;
