import {
  extractVideoId,
  fetchVideoMetadata,
  fetchTranscriptEntries,
  fetchChapters,
  buildAdRanges,
  filterEntriesExcludingRanges,
  type TranscriptEntry,
} from "../lib/youtube-helpers.js";
import type { Extractor } from "../types.js";
import {
  mediaSection,
  mediaSummary,
  pruneMediaDir,
  resetMediaDir,
  saveImage,
  saveVideo,
  type MediaFile,
} from "../lib/media.js";

const youtube: Extractor<"youtube"> = {
  source: "youtube",

  matches(url: string): boolean {
    return /(?:youtube\.com|youtu\.be)\//.test(url);
  },

  extractId(url: string): string {
    const id = extractVideoId(url);
    if (!id) throw new Error("Could not extract YouTube video ID from URL");
    return id;
  },

  async fetch(url: string, signal: AbortSignal, options?: Record<string, unknown>) {
    const id = extractVideoId(url);
    if (!id) throw new Error("Invalid YouTube URL");
    const stripAds = Boolean(options?.stripAds);

    const fetches: [
      ReturnType<typeof fetchVideoMetadata>,
      ReturnType<typeof fetchTranscriptEntries>,
      ReturnType<typeof fetchChapters>?
    ] = [fetchVideoMetadata(id), fetchTranscriptEntries(id)];
    if (stripAds) fetches.push(fetchChapters(id));

    const [metadata, rawEntries, chapterResult] = await Promise.all(fetches as any);

    let entries: TranscriptEntry[] = rawEntries;
    let strippedChapters: Array<{ title: string }> = [];
    if (stripAds && chapterResult) {
      const ranges = buildAdRanges(chapterResult.chapters);
      if (ranges.length > 0) {
        entries = filterEntriesExcludingRanges(entries, ranges);
        strippedChapters = ranges.map((r) => ({ title: r.title }));
      }
    }

    // The thumbnail always; the video only when asked for, since a YouTube
    // video is long and its transcript already carries what was said.
    const media: MediaFile[] = [];
    const mediaNotes: string[] = [];
    if (options?.downloadMedia !== false) {
      const dir = await resetMediaDir("youtube", id);
      const thumb =
        (await saveImage(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, dir, "thumbnail", signal)) ??
        (await saveImage(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, dir, "thumbnail", signal));
      if (thumb) media.push(thumb);
      if (options?.downloadVideo) {
        const saved = await saveVideo(`https://www.youtube.com/watch?v=${id}`, dir, signal);
        if (saved.file) media.push(saved.file);
        if (saved.error) mediaNotes.push(`Video not saved: ${saved.error}`);
      }
      await pruneMediaDir(dir);
    }
    const listed = mediaSection(media, mediaNotes);

    const content = [entries.map((e) => e.text).join(" ").trim(), listed].filter(Boolean).join("\n\n");

    return {
      title: metadata.title,
      content,
      source_specific: {
        channel: metadata.channel,
        duration: metadata.duration,
        durationSeconds: metadata.durationSeconds,
        publishDate: metadata.publishDate,
        viewCount: metadata.viewCount,
        description: metadata.description,
        ...mediaSummary(media),
        ...(stripAds
          ? { strippedChapters, adsStripped: strippedChapters.length }
          : {}),
      },
      raw: { entries },
    };
  },
};

export default youtube;
