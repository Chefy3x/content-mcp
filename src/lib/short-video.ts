import type { ExtractorResult } from "../types.js";
import { NoAudioError, transcribeFromUrl, videoInfo, type TranscribeResult, type VideoInfo } from "./transcribe.js";

// Instagram and TikTok posts are the same shape: a caption, some counts, and a
// short video whose point is usually what is said in it. So both extractors
// are this one function: yt-dlp for the post, Whisper for the speech.
//
// The transcript is on by default. A Reel saved as caption-only is mostly
// hashtags, and the spoken hook is what anyone saving it wants to read back.

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function count(n: number | undefined): string | null {
  return typeof n === "number" ? n.toLocaleString("en-US") : null;
}

export interface ShortVideoOptions {
  platform: "Instagram" | "TikTok";
  // Used when yt-dlp cannot read the post (a photo post, a login wall).
  fallback?: (url: string, signal: AbortSignal) => Promise<{ author?: string; caption: string } | null>;
}

export async function fetchShortVideo(
  url: string,
  signal: AbortSignal,
  options: Record<string, unknown> | undefined,
  { platform, fallback }: ShortVideoOptions
): Promise<ExtractorResult> {
  let info: VideoInfo | null = null;
  let infoError = "";
  try {
    info = await videoInfo(url, signal);
  } catch (err) {
    infoError = err instanceof Error ? err.message : String(err);
  }

  if (!info) {
    const basic = fallback ? await fallback(url, signal).catch(() => null) : null;
    if (!basic) {
      throw new Error(`${platform} post could not be read: ${oneLine(infoError).slice(-300)}`);
    }
    const author = basic.author || "unknown";
    return {
      title: `${author}: ${oneLine(basic.caption).slice(0, 80)}`,
      content: `> **${platform} post** — ${author}\n\n${basic.caption}\n\n_No video could be read for this post, so there is no transcript._`,
      source_specific: { platform, author, has_video: false, caption_only: true },
      raw: { fallback: basic, yt_dlp_error: oneLine(infoError).slice(-500) },
    };
  }

  const author = info.uploader || info.channel || info.uploader_id || "unknown";
  const caption = (info.description || info.title || "").trim();
  const posted = info.timestamp ? new Date(info.timestamp * 1000).toISOString() : undefined;
  const numbers = [
    ["views", count(info.view_count)],
    ["likes", count(info.like_count)],
    ["comments", count(info.comment_count)],
    ["shares", count(info.repost_count)],
  ].filter(([, v]) => v) as Array<[string, string]>;

  let transcript: TranscribeResult | null = null;
  let transcriptError = "";
  if (options?.transcribeVideo !== false) {
    try {
      transcript = await transcribeFromUrl(url, signal);
    } catch (err) {
      // The caption and counts are still worth saving without the speech.
      transcriptError =
        err instanceof NoAudioError
          ? "the video has no audio track"
          : oneLine(err instanceof Error ? err.message : String(err)).slice(-300);
    }
  }

  const parts = [
    `> **${platform} post** — ${author}${posted ? ` · ${posted.slice(0, 10)}` : ""}${
      info.duration ? ` · ${Math.round(info.duration)}s` : ""
    }`,
    numbers.length ? numbers.map(([k, v]) => `${v} ${k}`).join(" · ") : "",
    caption ? `## Caption\n\n${caption}` : "",
    transcript
      ? `## Video transcript\n\n_model: ${transcript.model}${
          transcript.language ? ` · lang: ${transcript.language}` : ""
        }_\n\n${transcript.text || "_(no speech detected)_"}`
      : transcriptError
        ? `_Transcript failed: ${transcriptError}_`
        : "",
  ].filter(Boolean);

  const titleBody = oneLine(caption);
  return {
    title: `${author}: ${titleBody.slice(0, 80)}${titleBody.length > 80 ? "…" : ""}`,
    content: parts.join("\n\n"),
    source_specific: {
      platform,
      author,
      handle: info.uploader_id || info.channel,
      created_at: posted,
      duration: info.duration,
      view_count: info.view_count,
      like_count: info.like_count,
      comment_count: info.comment_count,
      share_count: info.repost_count,
      has_video: true,
      ...(transcript
        ? {
            video_transcript: {
              model: transcript.model,
              language: transcript.language,
              segment_count: transcript.segments.length,
            },
          }
        : transcriptError
          ? { transcript_error: transcriptError }
          : {}),
    },
    raw: {
      caption,
      ...(transcript ? { video_transcript_segments: transcript.segments } : {}),
    },
  };
}
