// youtube-transcript@1.3.0 has a broken package.json ("type":"module" + CJS "main").
// Import the ESM build directly.
// @ts-ignore
import { YoutubeTranscript } from "youtube-transcript/dist/youtube-transcript.esm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  text: string;
  offset: number;   // ms
  duration: number;  // ms
}

export interface VideoMetadata {
  videoId: string;
  title: string;
  channel: string;
  duration: string;
  durationSeconds: number;
  publishDate: string;
  viewCount: number;
  description: string;
}

export interface Chapter {
  time: string;
  seconds: number;
  title: string;
}

export interface PlaylistVideo {
  index: number;
  title: string;
  videoId: string;
  url: string;
  duration: string;
}

export interface ChannelVideo {
  title: string;
  videoId: string;
  url: string;
  published: string;
  views: string;
  duration: string;
}

export interface TranscriptSummary {
  totalDuration: string;
  totalDurationSeconds: number;
  totalWords: number;
  wordsPerMinute: number;
  sections: Array<{
    index: number;
    timeRange: string;
    wordCount: number;
    preview: string;
  }>;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:m\.youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function extractPlaylistId(url: string): string | null {
  const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export function extractChannelIdentifier(url: string): string | null {
  // @handle format
  let match = url.match(/youtube\.com\/(@[a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // /channel/UCxxx format
  match = url.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // /c/name format
  match = url.match(/youtube\.com\/c\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // plain handle without URL
  if (url.startsWith("@")) return url;

  return null;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseTimestampToSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// YouTube page fetching
// ---------------------------------------------------------------------------

export async function fetchVideoPage(videoId: string): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return res.text();
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return res.text();
}

function extractYtInitialData(html: string): any | null {
  const match = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (match) {
    try { return JSON.parse(match[1]); } catch { return null; }
  }
  return null;
}

function extractYtInitialPlayerResponse(html: string): any | null {
  const match = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (match) {
    try { return JSON.parse(match[1]); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title fetching
// ---------------------------------------------------------------------------

export async function fetchVideoTitle(videoId: string): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const text = await res.text();

    let m = text.match(/<meta\s+name="title"\s+content="([^"]+)"/);
    if (m) {
      return decodeHTMLEntities(m[1]).trim() || `Untitled_${videoId}`;
    }

    m = text.match(/<title>(.+?)<\/title>/);
    if (m) {
      let title = decodeHTMLEntities(m[1]);
      title = title.replace(/\s*-\s*YouTube\s*$/, "");
      return title.trim() || `Untitled_${videoId}`;
    }

    return `Untitled_${videoId}`;
  } catch {
    return `Untitled_${videoId}`;
  }
}

export function sanitizeFilename(title: string): string {
  return title.replace(/[\\/*?:"<>|]/g, "").slice(0, 200).trim();
}

export function formatMarkdown(
  title: string,
  url: string,
  transcriptText: string
): string {
  const wordCount = transcriptText.split(/\s+/).filter(Boolean).length;
  return `# ${title}\n\n**Source:** ${url}\n\n**Word Count:** ${wordCount.toLocaleString()}\n\n---\n\n## Transcript\n\n${transcriptText}\n`;
}

// ---------------------------------------------------------------------------
// Transcript fetching
// ---------------------------------------------------------------------------

export async function fetchTranscriptEntries(
  videoId: string
): Promise<TranscriptEntry[]> {
  const entries = await YoutubeTranscript.fetchTranscript(videoId);
  if (!entries || entries.length === 0) {
    throw new Error("Transcript is empty");
  }
  return entries.map((e: any) => ({
    text: e.text as string,
    offset: e.offset as number,
    duration: e.duration as number,
  }));
}

export async function fetchTranscript(videoId: string): Promise<string> {
  const entries = await fetchTranscriptEntries(videoId);
  return entries.map((e) => e.text).join(" ").trim();
}

// ---------------------------------------------------------------------------
// Video metadata
// ---------------------------------------------------------------------------

export async function fetchVideoMetadata(
  videoId: string
): Promise<VideoMetadata> {
  const html = await fetchVideoPage(videoId);
  const playerResponse = extractYtInitialPlayerResponse(html);

  if (!playerResponse?.videoDetails) {
    throw new Error("Could not parse video metadata from YouTube page");
  }

  const vd = playerResponse.videoDetails;
  const micro = playerResponse.microformat?.playerMicroformatRenderer;

  const durationSeconds = parseInt(vd.lengthSeconds || "0", 10);

  return {
    videoId,
    title: decodeHTMLEntities(vd.title || `Untitled_${videoId}`),
    channel: decodeHTMLEntities(vd.author || "Unknown"),
    duration: formatTimestamp(durationSeconds),
    durationSeconds,
    publishDate: micro?.publishDate || "Unknown",
    viewCount: parseInt(vd.viewCount || "0", 10),
    description: (vd.shortDescription || "").slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export function parseChapters(description: string): Chapter[] {
  const chapters: Chapter[] = [];
  const lines = description.split("\n");
  for (const line of lines) {
    const match = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/);
    if (match) {
      const time = match[1];
      const title = match[2].trim();
      chapters.push({
        time,
        seconds: parseTimestampToSeconds(time),
        title,
      });
    }
  }
  return chapters;
}

const AD_CHAPTER_PATTERN =
  /\b(sponsor(ed|ship)?|ads?|advert(isement)?|promo(tion)?|plug)\b/i;

export function isAdChapter(title: string): boolean {
  return AD_CHAPTER_PATTERN.test(title);
}

// Build ms ranges [start, end) for chapters flagged as ads. End is the next
// chapter's start (or Infinity for the last chapter).
export function buildAdRanges(
  chapters: Chapter[]
): Array<{ start: number; end: number; title: string }> {
  const ranges: Array<{ start: number; end: number; title: string }> = [];
  for (let i = 0; i < chapters.length; i++) {
    if (!isAdChapter(chapters[i].title)) continue;
    const start = chapters[i].seconds * 1000;
    const end =
      i + 1 < chapters.length ? chapters[i + 1].seconds * 1000 : Infinity;
    ranges.push({ start, end, title: chapters[i].title });
  }
  return ranges;
}

export function filterEntriesExcludingRanges(
  entries: TranscriptEntry[],
  ranges: Array<{ start: number; end: number }>
): TranscriptEntry[] {
  if (ranges.length === 0) return entries;
  return entries.filter(
    (e) => !ranges.some((r) => e.offset >= r.start && e.offset < r.end)
  );
}

export async function fetchChapters(
  videoId: string
): Promise<{ title: string; chapters: Chapter[] }> {
  const html = await fetchVideoPage(videoId);

  // Try structured chapter data from ytInitialData
  const initialData = extractYtInitialData(html);
  if (initialData) {
    try {
      const panels = initialData.engagementPanels || [];
      for (const panel of panels) {
        const renderer =
          panel?.engagementPanelSectionListRenderer?.content
            ?.macroMarkersListRenderer?.contents;
        if (renderer) {
          const chapters: Chapter[] = renderer
            .filter((item: any) => item.macroMarkersListItemRenderer)
            .map((item: any) => {
              const r = item.macroMarkersListItemRenderer;
              const timeStr = r.timeDescription?.simpleText || "0:00";
              return {
                time: timeStr,
                seconds: parseTimestampToSeconds(timeStr),
                title: r.title?.simpleText || "Untitled",
              };
            });
          if (chapters.length > 0) {
            const title = extractTitleFromHtml(html, videoId);
            return { title, chapters };
          }
        }
      }
    } catch {
      // Fall through to description parsing
    }
  }

  // Fallback: parse chapters from description
  const playerResponse = extractYtInitialPlayerResponse(html);
  const description = playerResponse?.videoDetails?.shortDescription || "";
  const title = decodeHTMLEntities(
    playerResponse?.videoDetails?.title || `Untitled_${videoId}`
  );
  const chapters = parseChapters(description);

  return { title, chapters };
}

function extractTitleFromHtml(html: string, videoId: string): string {
  let m = html.match(/<meta\s+name="title"\s+content="([^"]+)"/);
  if (m) return decodeHTMLEntities(m[1]).trim();
  m = html.match(/<title>(.+?)<\/title>/);
  if (m) {
    let title = decodeHTMLEntities(m[1]);
    title = title.replace(/\s*-\s*YouTube\s*$/, "");
    return title.trim();
  }
  return `Untitled_${videoId}`;
}

// ---------------------------------------------------------------------------
// Transcript summary (structural, not LLM)
// ---------------------------------------------------------------------------

export function buildTranscriptSummary(
  entries: TranscriptEntry[]
): TranscriptSummary {
  if (entries.length === 0) {
    return {
      totalDuration: "0:00",
      totalDurationSeconds: 0,
      totalWords: 0,
      wordsPerMinute: 0,
      sections: [],
    };
  }

  const lastEntry = entries[entries.length - 1];
  const totalDurationMs = lastEntry.offset + lastEntry.duration;
  const totalDurationSeconds = Math.round(totalDurationMs / 1000);
  const allText = entries.map((e) => e.text).join(" ");
  const totalWords = allText.split(/\s+/).filter(Boolean).length;
  const totalMinutes = totalDurationSeconds / 60;
  const wordsPerMinute = totalMinutes > 0 ? Math.round(totalWords / totalMinutes) : 0;

  // Divide into ~10 segments by duration
  const segmentCount = Math.min(10, Math.max(1, Math.floor(totalDurationSeconds / 60)));
  const segmentDurationMs = totalDurationMs / segmentCount;

  const sections: TranscriptSummary["sections"] = [];
  for (let i = 0; i < segmentCount; i++) {
    const startMs = i * segmentDurationMs;
    const endMs = (i + 1) * segmentDurationMs;
    const segmentEntries = entries.filter(
      (e) => e.offset >= startMs && e.offset < endMs
    );
    const segmentText = segmentEntries.map((e) => e.text).join(" ");
    const segmentWords = segmentText.split(/\s+/).filter(Boolean);
    const preview = segmentWords.slice(0, 15).join(" ") + (segmentWords.length > 15 ? "..." : "");

    sections.push({
      index: i + 1,
      timeRange: `${formatTimestamp(Math.round(startMs / 1000))} - ${formatTimestamp(Math.round(endMs / 1000))}`,
      wordCount: segmentWords.length,
      preview,
    });
  }

  return {
    totalDuration: formatTimestamp(totalDurationSeconds),
    totalDurationSeconds,
    totalWords,
    wordsPerMinute,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Playlist videos
// ---------------------------------------------------------------------------

export async function fetchPlaylistVideos(
  playlistId: string,
  limit: number = 50
): Promise<{ playlistTitle: string; videos: PlaylistVideo[] }> {
  const html = await fetchPage(
    `https://www.youtube.com/playlist?list=${playlistId}`
  );
  const data = extractYtInitialData(html);
  if (!data) {
    throw new Error("Could not parse playlist data from YouTube page");
  }

  let playlistTitle = "Unknown Playlist";
  try {
    playlistTitle =
      data.metadata?.playlistMetadataRenderer?.title || playlistTitle;
  } catch {}

  const videos: PlaylistVideo[] = [];
  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const contents =
        tab.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
          ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer
          ?.contents;
      if (!contents) continue;

      for (const item of contents) {
        if (videos.length >= limit) break;
        const renderer = item.playlistVideoRenderer;
        if (!renderer) continue;

        videos.push({
          index: parseInt(renderer.index?.simpleText || "0", 10) + 1,
          title: renderer.title?.runs?.[0]?.text || "Untitled",
          videoId: renderer.videoId || "",
          url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
          duration: renderer.lengthText?.simpleText || "Unknown",
        });
      }
    }
  } catch {
    throw new Error("Could not extract playlist videos from YouTube page");
  }

  return { playlistTitle, videos };
}

// ---------------------------------------------------------------------------
// Channel videos
// ---------------------------------------------------------------------------

export async function fetchChannelVideos(
  channelIdentifier: string,
  limit: number = 10
): Promise<{ channel: string; videos: ChannelVideo[] }> {
  // Build URL based on identifier type
  let channelUrl: string;
  if (channelIdentifier.startsWith("UC")) {
    channelUrl = `https://www.youtube.com/channel/${channelIdentifier}/videos`;
  } else if (channelIdentifier.startsWith("@")) {
    channelUrl = `https://www.youtube.com/${channelIdentifier}/videos`;
  } else {
    channelUrl = `https://www.youtube.com/c/${channelIdentifier}/videos`;
  }

  const html = await fetchPage(channelUrl);
  const data = extractYtInitialData(html);
  if (!data) {
    throw new Error("Could not parse channel data from YouTube page");
  }

  let channelName = channelIdentifier;
  try {
    channelName =
      data.metadata?.channelMetadataRenderer?.title || channelName;
  } catch {}

  const videos: ChannelVideo[] = [];
  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const contents =
        tab.tabRenderer?.content?.richGridRenderer?.contents;
      if (!contents) continue;

      for (const item of contents) {
        if (videos.length >= limit) break;
        const renderer = item.richItemRenderer?.content?.videoRenderer;
        if (!renderer) continue;

        videos.push({
          title: renderer.title?.runs?.[0]?.text || "Untitled",
          videoId: renderer.videoId || "",
          url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
          published: renderer.publishedTimeText?.simpleText || "Unknown",
          views: renderer.viewCountText?.simpleText || "Unknown",
          duration: renderer.lengthText?.simpleText || "Unknown",
        });
      }
    }
  } catch {
    throw new Error("Could not extract channel videos from YouTube page");
  }

  return { channel: channelName, videos };
}
