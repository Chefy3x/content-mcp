import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "../types.js";
import { getContentDir } from "../storage.js";
import { run } from "./transcribe.js";

// The pictures and video behind a saved item, kept beside its text:
//   <CONTENT_DIR>/<source>/media/<source>_<id>/
// Text alone loses a post whose point is a screenshot, a chart or a clip, so
// every extractor saves what it can reach without a login and lists the local
// paths in the item's markdown, where a reader (or a model) can open them.

export interface MediaFile {
  kind: "image" | "video" | "frame";
  path: string;
  bytes: number;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// A clip longer than this is left on the platform: one long video should not
// fill the disk. CONTENT_MAX_VIDEO_MB overrides.
const MAX_VIDEO_MB = Number(process.env.CONTENT_MAX_VIDEO_MB) || 400;
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export function mediaDir(source: Source, id: string): string {
  return join(getContentDir(), source, "media", `${source}_${id}`);
}

// A fresh, empty folder for one item, so a refetch never mixes old files in.
export async function resetMediaDir(source: Source, id: string): Promise<string> {
  const dir = mediaDir(source, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

// Removes the folder again when nothing was saved into it.
export async function pruneMediaDir(dir: string): Promise<void> {
  const left = await readdir(dir).catch(() => []);
  if (!left.length) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function saveImage(
  url: string,
  dir: string,
  name: string,
  signal: AbortSignal,
  minBytes = 0
): Promise<MediaFile | null> {
  try {
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!ext) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < minBytes || data.length > MAX_IMAGE_BYTES) return null;
    const path = join(dir, `${name}.${ext}`);
    await writeFile(path, data);
    return { kind: "image", path, bytes: data.length };
  } catch {
    return null;
  }
}

// The video itself, through yt-dlp, as an mp4 of at most 1080p.
export async function saveVideo(
  url: string,
  dir: string,
  signal: AbortSignal
): Promise<{ file?: MediaFile; error?: string }> {
  try {
    await run(
      "yt-dlp",
      [
        "-S", "res:1080,ext:mp4:m4a",
        "--merge-output-format", "mp4",
        "--max-filesize", `${MAX_VIDEO_MB}M`,
        "--no-playlist",
        "--no-warnings",
        "-o", join(dir, "video.%(ext)s"),
        url,
      ],
      signal,
      dir
    );
    const name = (await readdir(dir)).find((f) => f.startsWith("video.") && !f.endsWith(".part"));
    if (!name) return { error: `video is larger than ${MAX_VIDEO_MB} MB, so it was not downloaded` };
    const path = join(dir, name);
    return { file: { kind: "video", path, bytes: (await stat(path)).size } };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
    return { error: message.slice(-240) };
  }
}

export async function probeVideo(
  path: string,
  signal: AbortSignal
): Promise<{ duration: number; hasAudio: boolean }> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path],
    signal
  );
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  return {
    duration: Number(info.format?.duration) || 0,
    hasAudio: (info.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

// A few stills spread across the clip, so what is on screen can be looked at
// without playing the video.
export async function saveFrames(
  videoPath: string,
  dir: string,
  duration: number,
  signal: AbortSignal,
  count = 4
): Promise<MediaFile[]> {
  const out: MediaFile[] = [];
  if (!(duration > 0)) return out;
  for (let i = 0; i < count; i++) {
    const at = (duration * (i + 0.5)) / count;
    const path = join(dir, `frame_${i + 1}.jpg`);
    try {
      await run(
        "ffmpeg",
        ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", videoPath, "-frames:v", "1", "-q:v", "3", "-vf", "scale='min(1280,iw)':-2", path],
        signal
      );
      out.push({ kind: "frame", path, bytes: (await stat(path)).size });
    } catch {
      // A frame that will not decode is skipped; the others still help.
    }
  }
  return out;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The markdown block that lists what was saved, with paths a reader can open.
export function mediaSection(files: MediaFile[], notes: string[] = []): string {
  if (!files.length && !notes.length) return "";
  const label = { image: "Image", video: "Video", frame: "Video still" } as const;
  return [
    "## Media",
    "",
    ...files.map((f) => `- ${label[f.kind]}: \`${f.path}\` (${size(f.bytes)})`),
    ...notes.map((n) => `- _${n}_`),
  ].join("\n");
}

export function mediaSummary(files: MediaFile[]): Record<string, unknown> {
  if (!files.length) return {};
  return {
    media_files: files.map((f) => ({ kind: f.kind, path: f.path, bytes: f.bytes })),
  };
}
