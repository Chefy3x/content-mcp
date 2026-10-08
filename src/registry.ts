import { createHash } from "node:crypto";
import type { Extractor, ContentMeta, Source } from "./types.js";
import { saveContent, readSidecar, type SavedContent } from "./storage.js";

interface ExtractorEntry {
  source: Source;
  load: () => Promise<Extractor>;
}

// Lazy loaders — a broken extractor won't crash server startup.
// Order matters: article is the catch-all, so it must come last.
const ENTRIES: ExtractorEntry[] = [
  {
    source: "youtube",
    load: async () => (await import("./extractors/youtube.js")).default,
  },
  {
    source: "x",
    load: async () => (await import("./extractors/x.js")).default,
  },
  {
    source: "paper",
    load: async () => (await import("./extractors/paper.js")).default,
  },
  {
    source: "article",
    load: async () => (await import("./extractors/article.js")).default,
  },
];

const cache = new Map<Source, Extractor>();

async function getExtractor(source: Source): Promise<Extractor> {
  const cached = cache.get(source);
  if (cached) return cached;
  const entry = ENTRIES.find((e) => e.source === source);
  if (!entry) throw new Error(`No extractor registered for source: ${source}`);
  const ex = await entry.load();
  cache.set(source, ex);
  return ex;
}

export async function findExtractor(url: string): Promise<Extractor | null> {
  for (const entry of ENTRIES) {
    const ex = await getExtractor(entry.source).catch(() => null);
    if (ex && ex.matches(url)) return ex;
  }
  return null;
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url.trim();
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export interface FetchOptions {
  refresh?: boolean;
  signal?: AbortSignal;
  sourceOptions?: Record<string, unknown>;
}

export interface FetchOutcome extends SavedContent {
  cached: boolean;
}

export async function fetchAndSave(
  url: string,
  options: FetchOptions = {}
): Promise<FetchOutcome> {
  const extractor = await findExtractor(url);
  if (!extractor) throw new Error(`No extractor matches URL: ${url}`);

  const id = extractor.extractId(url);
  if (!id) throw new Error(`Extractor ${extractor.source} could not extract id from URL`);

  if (!options.refresh) {
    const existing = await readSidecar(extractor.source, id);
    if (existing) {
      const stale = extractor.isStale?.(existing.meta) ?? false;
      if (!stale) {
        return {
          meta: existing.meta,
          mdPath: mdPathFor(extractor.source, id),
          jsonPath: jsonPathFor(extractor.source, id),
          cached: true,
        };
      }
    }
  }

  const signal = options.signal ?? new AbortController().signal;
  const result = await extractor.fetch(url, signal, options.sourceOptions);

  const meta: ContentMeta = {
    source: extractor.source,
    id,
    url: normalizeUrl(url),
    title: result.title,
    fetched_at: new Date().toISOString(),
    content_hash: hash(result.content),
    source_specific: result.source_specific,
  };

  const saved = await saveContent(meta, result.content, result.raw);
  return { ...saved, cached: false };
}

// Mirror the private path helpers in storage.ts for the cached-return path.
import { join } from "node:path";
import { getContentDir } from "./storage.js";

function mdPathFor(source: Source, id: string): string {
  return join(getContentDir(), source, `${source}_${id}.content.md`);
}

function jsonPathFor(source: Source, id: string): string {
  return join(getContentDir(), source, `${source}_${id}.content.json`);
}
