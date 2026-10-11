import { createHash } from "node:crypto";
import type { Extractor } from "../types.js";
import { fetchShortVideo } from "../lib/short-video.js";

const VIDEO = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/;
// Share links from the app: vm.tiktok.com/<code>, vt.tiktok.com/<code>, tiktok.com/t/<code>.
const SHARE = /^https?:\/\/(?:(?:vm|vt)\.tiktok\.com\/|(?:www\.)?tiktok\.com\/t\/)([A-Za-z0-9]+)/;

// TikTok's own oEmbed: the caption and author, with no video behind it.
async function oembedCaption(url: string, signal: AbortSignal) {
  const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as { title?: string; author_name?: string };
  return data.title ? { author: data.author_name, caption: data.title } : null;
}

const tiktok: Extractor<"tiktok"> = {
  source: "tiktok",

  matches(url: string): boolean {
    return VIDEO.test(url) || SHARE.test(url);
  },

  extractId(url: string): string {
    const video = url.match(VIDEO);
    if (video) return video[1];
    const share = url.match(SHARE);
    // A share code is not the video id, and resolving it needs a request, so
    // the stored id is a hash of the code: stable for the same link.
    if (share) return createHash("sha256").update(share[1]).digest("hex").slice(0, 16);
    throw new Error("Could not extract TikTok video ID from URL");
  },

  fetch(url: string, signal: AbortSignal, options?: Record<string, unknown>) {
    return fetchShortVideo(url, signal, options, {
      platform: "TikTok",
      source: "tiktok",
      id: this.extractId(url),
      fallback: oembedCaption,
    });
  },
};

export default tiktok;
