import type { Extractor } from "../types.js";
import {
  NoAudioError,
  transcribeFromFile,
  transcribeFromUrl,
  type TranscribeResult,
} from "../lib/transcribe.js";
import {
  mediaSection,
  mediaSummary,
  probeVideo,
  pruneMediaDir,
  resetMediaDir,
  saveFrames,
  saveImage,
  saveVideo,
  type MediaFile,
} from "../lib/media.js";

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
  // Present on a long post ("note tweet"). The syndication endpoint then
  // returns only the first 280 characters in `text`.
  note_tweet?: { id?: string };
  // The whole post, filled in by fetchTweet for a note tweet.
  note_text?: string;
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
  const tweet = (await res.json()) as SyndicationTweet;
  await fillNote(tweet, signal);
  if (tweet.quoted_tweet) await fillNote(tweet.quoted_tweet, signal);
  return tweet;
}

// A long post comes back cut at 280 characters. FxTwitter's public API serves
// the whole text with no login, so a note tweet is read from there. If that
// fails the cut text is kept and marked, never passed off as the full post.
async function fillNote(tweet: SyndicationTweet, signal: AbortSignal): Promise<void> {
  if (!tweet.note_tweet || !tweet.id_str) return;
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${encodeURIComponent(tweet.id_str)}`, {
      signal,
      headers: { "User-Agent": "content-mcp (+https://github.com/Chefy3x/content-mcp)" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { tweet?: { text?: string } };
    const text = data.tweet?.text?.trim();
    if (text && text.length > (tweet.text || "").length - 30) tweet.note_text = text;
  } catch {
    // Keep the cut text; tweetBody marks it.
  }
}

function tweetBody(tweet: SyndicationTweet): string {
  if (tweet.note_text) return tweet.note_text;
  if (tweet.note_tweet) return `${cutBody(tweet)}… _[long post, cut off here: the rest could not be read]_`;
  return cutBody(tweet);
}

function cutBody(tweet: SyndicationTweet): string {
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

    const hasVideo = (root.mediaDetails ?? []).some((m) => m.type === "video" || m.type === "animated_gif");

    // The post's pictures and its video, saved beside the text. A post that is
    // one line and a screenshot is otherwise saved without its point.
    const media: MediaFile[] = [];
    const mediaNotes: string[] = [];
    let video: MediaFile | undefined;
    let hasAudio = true;
    if (options?.downloadMedia !== false) {
      const dir = await resetMediaDir("x", rootId);
      const photos = [root, ...(root.quoted_tweet ? [root.quoted_tweet] : [])].flatMap((t) =>
        (t.mediaDetails ?? []).filter((m) => m.type === "photo" && m.media_url_https).map((m) => m.media_url_https!)
      );
      for (const [i, photo] of photos.entries()) {
        const image = await saveImage(`${photo}?name=large`, dir, `image_${i + 1}`, signal);
        if (image) media.push(image);
      }
      if (hasVideo) {
        const saved = await saveVideo(url, dir, signal);
        video = saved.file;
        if (saved.error) mediaNotes.push(`Video not saved: ${saved.error}`);
        if (video) {
          media.push(video);
          const probe = await probeVideo(video.path, signal).catch(() => ({ duration: 0, hasAudio: true }));
          hasAudio = probe.hasAudio;
          media.push(...(await saveFrames(video.path, dir, probe.duration, signal)));
        }
      }
      await pruneMediaDir(dir);
    }

    let transcript: TranscribeResult | null = null;
    let videoNote = "";
    // A video already on disk is transcribed as a matter of course; without
    // one it stays opt-in, because it means a download of its own.
    if (hasVideo && (video ? options?.transcribeVideo !== false : transcribeVideo)) {
      // The post itself is still worth saving when its video cannot be heard.
      try {
        transcript = video
          ? await transcribeFromFile(video.path, hasAudio, signal)
          : await transcribeFromUrl(url, signal);
        parts.push(
          `## Video transcript\n\n_model: ${transcript.model}${
            transcript.language ? ` · lang: ${transcript.language}` : ""
          }_\n\n${transcript.text || "_(no speech detected)_"}`
        );
      } catch (err) {
        videoNote =
          err instanceof NoAudioError
            ? "The attached video has no audio track, so there is nothing to transcribe."
            : `Transcript failed: ${oneLine(err instanceof Error ? err.message : String(err)).slice(-300)}`;
        parts.push(`## Video\n\n_${videoNote}_`);
      }
    }

    const listed = mediaSection(media, mediaNotes);
    if (listed) parts.push(listed);

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
        ...mediaSummary(media),
        is_long_post: Boolean(root.note_tweet),
        ...(root.note_tweet && !root.note_text ? { text_truncated: true } : {}),
        ...(videoNote ? { video_note: videoNote } : {}),
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
