// Add a literal here when a new extractor lands.
export type Source = "youtube" | "x" | "instagram" | "tiktok" | "paper" | "article";

export interface ContentMeta {
  source: Source;
  id: string;
  url: string;
  title: string;
  fetched_at: string;
  content_hash: string;
  source_specific: Record<string, unknown>;
}

export interface ExtractorResult {
  title: string;
  content: string;
  source_specific: Record<string, unknown>;
  raw?: unknown;
}

export interface Extractor<S extends Source = Source> {
  source: S;
  matches(url: string): boolean;
  extractId(url: string): string;
  fetch(
    url: string,
    signal: AbortSignal,
    options?: Record<string, unknown>
  ): Promise<ExtractorResult>;
  isStale?(meta: ContentMeta): boolean;
}
