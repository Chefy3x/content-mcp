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

  async fetch(url: string, _signal: AbortSignal, options?: Record<string, unknown>) {
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

    const content = entries.map((e) => e.text).join(" ").trim();

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
        ...(stripAds
          ? { strippedChapters, adsStripped: strippedChapters.length }
          : {}),
      },
      raw: { entries },
    };
  },
};

export default youtube;
