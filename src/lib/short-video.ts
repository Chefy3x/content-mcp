import type { ExtractorResult } from "../types.js";
import type { Source } from "../types.js";
import {
  NoAudioError,
  transcribeFromFile,
  transcribeFromUrl,
  videoInfo,
  type TranscribeResult,
  type VideoInfo,
} from "./transcribe.js";
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
} from "./media.js";

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
  source: Source;
  id: string;
  // Used when yt-dlp cannot read the post (a photo post, a login wall).
  fallback?: (
    url: string,
    signal: AbortSignal
  ) => Promise<{ author?: string; caption: string; image?: string } | null>;
}

export async function fetchShortVideo(
  url: string,
  signal: AbortSignal,
  options: Record<string, unknown> | undefined,
  { platform, source, id, fallback }: ShortVideoOptions
): Promise<ExtractorResult> {
  const wantMedia = options?.downloadMedia !== false;
  const dir = wantMedia ? await resetMediaDir(source, id) : "";
  const media: MediaFile[] = [];
  const mediaNotes: string[] = [];
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
    if (dir) {
      // A photo post: the preview image is the one picture reachable without a login.
      const image = basic.image ? await saveImage(basic.image, dir, "image_1", signal) : null;
      if (image) media.push(image);
      await pruneMediaDir(dir);
    }
    return {
      title: `${author}: ${oneLine(basic.caption).slice(0, 80)}`,
      content: [
        `> **${platform} post** — ${author}`,
        basic.caption,
        "_No video could be read for this post, so there is no transcript._",
        mediaSection(media, media.length ? ["A carousel's other pictures need a login and are not saved."] : []),
      ]
        .filter(Boolean)
        .join("\n\n"),
      source_specific: { platform, author, has_video: false, caption_only: true, ...mediaSummary(media) },
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

  // The clip itself, a few stills from it, and its cover image.
  let video: MediaFile | undefined;
  let hasAudio = true;
  if (dir) {
    const saved = await saveVideo(url, dir, signal);
    video = saved.file;
    if (saved.error) mediaNotes.push(`Video not saved: ${saved.error}`);
    if (video) {
      media.push(video);
      const probe = await probeVideo(video.path, signal).catch(() => ({ duration: info.duration ?? 0, hasAudio: true }));
      hasAudio = probe.hasAudio;
      media.push(...(await saveFrames(video.path, dir, probe.duration || info.duration || 0, signal)));
    }
    const cover = info.thumbnail ? await saveImage(info.thumbnail, dir, "cover", signal) : null;
    if (cover) media.push(cover);
    await pruneMediaDir(dir);
  }

  let transcript: TranscribeResult | null = null;
  let transcriptError = "";
  if (options?.transcribeVideo !== false) {
    try {
      transcript = video
        ? await transcribeFromFile(video.path, hasAudio, signal)
        : await transcribeFromUrl(url, signal);
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
    mediaSection(media, mediaNotes),
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
      ...mediaSummary(media),
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
