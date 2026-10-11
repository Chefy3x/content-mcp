import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchAndSave, findExtractor } from "./registry.js";
import {
  listContent,
  searchContent,
  readSidecar,
  deleteContent,
} from "./storage.js";
import type { Source } from "./types.js";
import {
  extractVideoId,
  extractPlaylistId,
  extractChannelIdentifier,
  fetchChapters,
  fetchChannelVideos,
  fetchPlaylistVideos,
  fetchTranscriptEntries,
  fetchVideoMetadata,
  buildTranscriptSummary,
  formatTimestamp,
  type TranscriptEntry,
} from "./lib/youtube-helpers.js";

const SOURCE_ENUM = z.enum(["youtube", "x", "instagram", "tiktok", "paper", "article"]);

const server = new McpServer({
  name: "content-mcp",
  version: "0.1.0",
});

const jsonText = (data: unknown, pretty = false) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(data, null, pretty ? 2 : 0) },
  ],
});

// ---------------------------------------------------------------------------
// Universal tools
// ---------------------------------------------------------------------------

server.tool(
  "get_content",
  "Fetch content from any supported URL and save a normalized markdown + JSON pair to CONTENT_DIR. Returns metadata only. Source is inferred from the URL.",
  {
    url: z.string().describe("URL to fetch"),
    refresh: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, re-fetch even if a cached copy exists"),
    stripAds: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "YouTube only: drop transcript entries inside chapters titled sponsor/ad/promo. Ignored for other sources."
      ),
    transcribeVideo: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "X/Twitter only, and only when downloadMedia is false: transcribe the tweet's video via yt-dlp + Whisper. With media on (the default), any saved video that has sound is transcribed anyway, as Instagram and TikTok posts always are."
      ),
    downloadMedia: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Save the item's pictures and video beside its text: an X post's images and video, an Instagram or TikTok clip with a few stills from it, a YouTube thumbnail, an article's lead image and figures. Their local paths are listed under '## Media' in the saved markdown and in source_specific.media_files. Set false for text only."
      ),
    downloadVideo: z
      .boolean()
      .optional()
      .default(false)
      .describe("YouTube only: also download the video itself (up to 1080p). Off by default because YouTube videos are long."),
  },
  async ({ url, refresh, stripAds, transcribeVideo, downloadMedia, downloadVideo }) => {
    try {
      const sourceOptions: Record<string, unknown> = {};
      if (stripAds) sourceOptions.stripAds = true;
      if (transcribeVideo) sourceOptions.transcribeVideo = true;
      if (downloadMedia === false) sourceOptions.downloadMedia = false;
      if (downloadVideo) sourceOptions.downloadVideo = true;
      const outcome = await fetchAndSave(url, {
        refresh,
        sourceOptions: Object.keys(sourceOptions).length ? sourceOptions : undefined,
      });
      return jsonText({
        source: outcome.meta.source,
        id: outcome.meta.id,
        title: outcome.meta.title,
        url: outcome.meta.url,
        fetched_at: outcome.meta.fetched_at,
        content_hash: outcome.meta.content_hash,
        cached: outcome.cached,
        mdPath: outcome.mdPath,
        jsonPath: outcome.jsonPath,
        source_specific: outcome.meta.source_specific,
      });
    } catch (e) {
      return jsonText({ error: e instanceof Error ? e.message : String(e), url });
    }
  }
);

server.tool(
  "batch_content",
  "Fetch multiple URLs sequentially and save them. Good for rate-limit-sensitive sources. Mixed sources are fine — each URL dispatches to the right extractor.",
  {
    urls: z.array(z.string()).describe("Array of URLs to fetch"),
    refresh: z.boolean().optional().default(false).describe("Re-fetch cached items"),
    stripAds: z
      .boolean()
      .optional()
      .default(false)
      .describe("YouTube only: ad-chapter stripping"),
    transcribeVideo: z
      .boolean()
      .optional()
      .default(false)
      .describe("X/Twitter only, when downloadMedia is false: transcribe tweet video via Whisper"),
    downloadMedia: z
      .boolean()
      .optional()
      .default(true)
      .describe("Save each item's pictures and video beside its text (see get_content). Set false for text only."),
  },
  async ({ urls, refresh, stripAds, transcribeVideo, downloadMedia }) => {
    const sourceOptions: Record<string, unknown> = {};
    if (stripAds) sourceOptions.stripAds = true;
    if (transcribeVideo) sourceOptions.transcribeVideo = true;
    if (downloadMedia === false) sourceOptions.downloadMedia = false;
    const opts = Object.keys(sourceOptions).length ? sourceOptions : undefined;
    const results: Array<Record<string, unknown>> = [];
    for (const url of urls) {
      try {
        const outcome = await fetchAndSave(url.trim(), {
          refresh,
          sourceOptions: opts,
        });
        results.push({
          url,
          success: true,
          source: outcome.meta.source,
          id: outcome.meta.id,
          title: outcome.meta.title,
          cached: outcome.cached,
          mdPath: outcome.mdPath,
        });
      } catch (e) {
        results.push({
          url,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return jsonText(results, true);
  }
);

server.tool(
  "get_metadata",
  "Return metadata for a URL. Uses cached data if present; otherwise live-fetches just the metadata (no body saved). Does not trigger a transcript fetch.",
  { url: z.string().describe("URL whose metadata to look up") },
  async ({ url }) => {
    const extractor = await findExtractor(url);
    if (!extractor) return jsonText({ error: "No extractor matches URL", url });

    let id: string;
    try {
      id = extractor.extractId(url);
    } catch {
      return jsonText({ error: "Could not extract ID from URL", url });
    }

    const sidecar = await readSidecar(extractor.source, id);
    if (sidecar) return jsonText({ cached: true, meta: sidecar.meta });

    // Live fetch metadata only, per-source.
    if (extractor.source === "youtube") {
      try {
        const meta = await fetchVideoMetadata(id);
        return jsonText({ cached: false, source: "youtube", id, ...meta });
      } catch (e) {
        return jsonText({ error: e instanceof Error ? e.message : String(e), url });
      }
    }

    return jsonText({
      cached: false,
      source: extractor.source,
      id,
      note: "Live metadata fetch not implemented for this source yet",
    });
  }
);

server.tool(
  "list_content",
  "List saved content across all sources, or for one source.",
  { source: SOURCE_ENUM.optional().describe("Optional source filter") },
  async ({ source }) => jsonText(await listContent(source as Source | undefined), true)
);

server.tool(
  "search_content",
  "Ranked keyword search across saved content. Optionally scope to one source or one saved item.",
  {
    query: z.string().describe("Search query (supports multiple keywords)"),
    limit: z.number().optional().default(10).describe("Max results"),
    source: SOURCE_ENUM.optional().describe("Optional source filter"),
    id: z
      .string()
      .optional()
      .describe("Optional: restrict to a single saved item (requires source)"),
  },
  async ({ query, limit, source, id }) => {
    if (id && !source) {
      return jsonText({ error: "id filter requires source" });
    }
    const results = await searchContent(query, limit, source as Source | undefined, id);
    return jsonText({ query, totalMatches: results.length, results }, true);
  }
);

server.tool(
  "delete_content",
  "Delete a saved content item (both the markdown and JSON sidecar).",
  {
    source: SOURCE_ENUM.describe("Source namespace"),
    id: z.string().describe("Content ID within the source"),
  },
  async ({ source, id }) => {
    try {
      const result = await deleteContent(source as Source, id);
      return jsonText({ source, id, ...result });
    } catch (e) {
      return jsonText({
        error: e instanceof Error ? e.message : String(e),
        source,
        id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// YouTube-specific tools
// ---------------------------------------------------------------------------

server.tool(
  "youtube_get_chapters",
  "Extract YouTube chapter markers (timestamps + titles). Returns an outline without reading the full transcript.",
  { url: z.string().describe("YouTube video URL") },
  async ({ url }) => {
    const videoId = extractVideoId(url);
    if (!videoId) return jsonText({ error: "Invalid YouTube URL" });
    const { title, chapters } = await fetchChapters(videoId);
    return jsonText(
      { videoId, title, chapterCount: chapters.length, chapters },
      true
    );
  }
);

server.tool(
  "youtube_get_transcript_segment",
  "Return YouTube transcript text for a specific time range. Uses cached entries when available; otherwise live-fetches.",
  {
    url: z.string().describe("YouTube video URL"),
    startTime: z.number().describe("Start time in seconds"),
    endTime: z.number().describe("End time in seconds"),
  },
  async ({ url, startTime, endTime }) => {
    const videoId = extractVideoId(url);
    if (!videoId) return jsonText({ error: "Invalid YouTube URL" });

    let entries: TranscriptEntry[] | null = null;
    const sidecar = await readSidecar("youtube", videoId);
    if (sidecar) {
      const raw = sidecar.raw as { entries?: TranscriptEntry[] } | undefined;
      if (raw?.entries) entries = raw.entries;
    }
    if (!entries) {
      entries = await fetchTranscriptEntries(videoId);
    }

    const startMs = startTime * 1000;
    const endMs = endTime * 1000;
    const filtered = entries.filter((e) => e.offset >= startMs && e.offset < endMs);
    const text = filtered.map((e) => e.text).join(" ").trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return jsonText({
      videoId,
      timeRange: `${formatTimestamp(startTime)} - ${formatTimestamp(endTime)}`,
      wordCount,
      text,
    });
  }
);

server.tool(
  "youtube_get_channel_videos",
  "List recent videos from a YouTube channel.",
  {
    url: z
      .string()
      .describe("YouTube channel URL or handle (e.g., https://youtube.com/@handle or @handle)"),
    limit: z.number().optional().default(10).describe("Number of videos (max 30)"),
  },
  async ({ url, limit }) => {
    const identifier = extractChannelIdentifier(url);
    if (!identifier) return jsonText({ error: "Invalid channel URL or handle" });
    const result = await fetchChannelVideos(identifier, Math.min(limit, 30));
    return jsonText(
      {
        channel: result.channel,
        videoCount: result.videos.length,
        videos: result.videos,
      },
      true
    );
  }
);

server.tool(
  "youtube_get_playlist_videos",
  "List all videos in a YouTube playlist.",
  {
    url: z.string().describe("YouTube playlist URL"),
    limit: z.number().optional().default(50).describe("Max videos (max 200)"),
  },
  async ({ url, limit }) => {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) return jsonText({ error: "Invalid playlist URL" });
    const result = await fetchPlaylistVideos(playlistId, Math.min(limit, 200));
    return jsonText(
      {
        playlistId,
        playlistTitle: result.playlistTitle,
        videoCount: result.videos.length,
        videos: result.videos,
      },
      true
    );
  }
);

server.tool(
  "youtube_summarize_transcript",
  "Structural overview of a YouTube transcript: sections with time ranges, word counts, and previews. Not an LLM summary.",
  { url: z.string().describe("YouTube video URL") },
  async ({ url }) => {
    const videoId = extractVideoId(url);
    if (!videoId) return jsonText({ error: "Invalid YouTube URL" });

    const sidecar = await readSidecar("youtube", videoId);
    let entries: TranscriptEntry[];
    let title: string;

    if (sidecar) {
      const raw = sidecar.raw as { entries?: TranscriptEntry[] } | undefined;
      if (!raw?.entries) {
        return jsonText({
          error:
            "Saved sidecar has no transcript entries. Call get_content first to populate the cache.",
        });
      }
      entries = raw.entries;
      title = sidecar.meta.title;
    } else {
      const [meta, fetched] = await Promise.all([
        fetchVideoMetadata(videoId),
        fetchTranscriptEntries(videoId),
      ]);
      title = meta.title;
      entries = fetched;
    }

    return jsonText({ videoId, title, ...buildTranscriptSummary(entries) }, true);
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
