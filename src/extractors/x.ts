import type { Extractor } from "../types.js";
import { transcribeFromUrl, type TranscribeResult } from "../lib/transcribe.js";

// Twitter's syndication endpoint is no-auth and powers embeds. Token is a
// deterministic hash of the tweet ID.
function syndicationToken(id: string): string {
  const n = (Number(id) / 1e15) * Math.PI;
  return n.toString(36).replace(/(0+|\.)/g, "");
}

interface TweetEntity {
  url: string;
  expanded_url?: string;
  indices?: [number, number];
}

interface SyndicationTweet {
  id_str: string;
  text?: string;
  full_text?: string;
  display_text_range?: [number, number];
  created_at?: string;
  user?: { name?: string; screen_name?: string; verified?: boolean };
  favorite_count?: number;
  conversation_count?: number;
  in_reply_to_status_id_str?: string;
  parent?: SyndicationTweet;
  quoted_tweet?: SyndicationTweet;
  mediaDetails?: Array<{ type?: string; media_url_https?: string }>;
  entities?: {
    urls?: TweetEntity[];
    media?: TweetEntity[];
  };
}

async function fetchTweet(id: string, signal: AbortSignal): Promise<SyndicationTweet> {
  const token = syndicationToken(id);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(
    id
  )}&lang=en&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Twitter syndication returned ${res.status} for id ${id}`);
  }
  return (await res.json()) as SyndicationTweet;
}

function tweetBody(tweet: SyndicationTweet): string {
  const raw = tweet.full_text || tweet.text || "";
  // Crop trailing attached media (e.g. "... Live Now. https://t.co/abc").
  const end = tweet.display_text_range?.[1];
  let body = end != null ? raw.slice(0, end) : raw;

  // Replace in-body t.co shortlinks with their expanded URL.
  for (const ent of tweet.entities?.urls ?? []) {
    if (!ent.expanded_url) continue;
    body = body.split(ent.url).join(ent.expanded_url);
  }
  // Strip any remaining inline media shortlinks (already attached as media).
  for (const ent of tweet.entities?.media ?? []) {
    body = body.split(ent.url).join("");
  }

  return body.trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatTweet(tweet: SyndicationTweet, role: string): string {
  const author = tweet.user?.screen_name ? `@${tweet.user.screen_name}` : "?";
  const when = tweet.created_at || "";
  const body = tweetBody(tweet);
  return `> **${role}** — ${author}${when ? ` · ${when}` : ""}\n\n${body}`.trim();
}

const MAX_PARENT_DEPTH = 6;

const x: Extractor<"x"> = {
  source: "x",

  matches(url: string): boolean {
    return /^https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/.test(
      url
    );
  },

  extractId(url: string): string {
    const m = url.match(/\/status\/(\d+)/);
    if (!m) throw new Error("Could not extract tweet ID from URL");
    return m[1];
  },

  async fetch(url: string, signal: AbortSignal, options?: Record<string, unknown>) {
    const rootId = this.extractId(url);
    const root = await fetchTweet(rootId, signal);
    const transcribeVideo = Boolean(options?.transcribeVideo);

    // Walk parents up to MAX_PARENT_DEPTH so we capture thread context.
    const chain: SyndicationTweet[] = [root];
    let parentId = root.in_reply_to_status_id_str;
    let depth = 0;
    while (parentId && depth < MAX_PARENT_DEPTH) {
      try {
        const parent = await fetchTweet(parentId, signal);
        chain.unshift(parent);
        parentId = parent.in_reply_to_status_id_str;
      } catch {
        break;
      }
      depth++;
    }

    const parts: string[] = [];
    chain.forEach((t, i) => {
      const role = i === chain.length - 1 ? "Tweet" : "Reply-to";
      parts.push(formatTweet(t, role));
    });

    if (root.quoted_tweet) {
      parts.push(formatTweet(root.quoted_tweet, "Quoted"));
    }

    const hasVideo = (root.mediaDetails ?? []).some((m) => m.type === "video");
    let transcript: TranscribeResult | null = null;
    if (transcribeVideo && hasVideo) {
      transcript = await transcribeFromUrl(url, signal);
      parts.push(
        `## Video transcript\n\n_model: ${transcript.model}${
          transcript.language ? ` · lang: ${transcript.language}` : ""
        }_\n\n${transcript.text}`
      );
    }

    const content = parts.join("\n\n---\n\n");
    const author = root.user?.screen_name || "unknown";
    const titleBody = oneLine(tweetBody(root));
    const title = `${author}: ${titleBody.slice(0, 80)}${
      titleBody.length > 80 ? "…" : ""
    }`;

    return {
      title,
      content,
      source_specific: {
        author: root.user?.name,
        handle: root.user?.screen_name,
        verified: root.user?.verified ?? false,
        created_at: root.created_at,
        favorite_count: root.favorite_count,
        conversation_count: root.conversation_count,
        thread_depth: chain.length,
        has_quote: Boolean(root.quoted_tweet),
        media:
          root.mediaDetails?.map((m) => ({
            type: m.type,
            url: m.media_url_https,
          })) ?? [],
        has_video: hasVideo,
        ...(transcript
          ? {
              video_transcript: {
                model: transcript.model,
                language: transcript.language,
                segment_count: transcript.segments.length,
              },
            }
          : {}),
      },
      raw: {
        chain,
        quoted: root.quoted_tweet,
        ...(transcript ? { video_transcript_segments: transcript.segments } : {}),
      },
    };
  },
};

export default x;
