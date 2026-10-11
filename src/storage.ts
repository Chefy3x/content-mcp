import { readdir, readFile, writeFile, mkdir, stat, unlink, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ContentMeta, Source } from "./types.js";

export function getContentDir(): string {
  return process.env.CONTENT_DIR || join(homedir(), "Documents", "Content");
}

function sourceDir(source: Source): string {
  return join(getContentDir(), source);
}

export async function ensureSourceDir(source: Source): Promise<void> {
  await mkdir(sourceDir(source), { recursive: true });
}

function slug(source: Source, id: string): string {
  return `${source}_${id}`;
}

function mdPath(source: Source, id: string): string {
  return join(sourceDir(source), `${slug(source, id)}.content.md`);
}

function jsonPath(source: Source, id: string): string {
  return join(sourceDir(source), `${slug(source, id)}.content.json`);
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, path);
}

export interface SavedContent {
  meta: ContentMeta;
  mdPath: string;
  jsonPath: string;
}

export async function saveContent(
  meta: ContentMeta,
  body: string,
  raw: unknown
): Promise<SavedContent> {
  await ensureSourceDir(meta.source);
  const md = formatMarkdown(meta, body);
  const json = JSON.stringify({ meta, raw }, null, 2);
  const md_path = mdPath(meta.source, meta.id);
  const json_path = jsonPath(meta.source, meta.id);
  await Promise.all([writeAtomic(md_path, md), writeAtomic(json_path, json)]);
  return { meta, mdPath: md_path, jsonPath: json_path };
}

export async function readMeta(source: Source, id: string): Promise<ContentMeta | null> {
  try {
    const raw = await readFile(jsonPath(source, id), "utf-8");
    const parsed = JSON.parse(raw) as { meta: ContentMeta };
    return parsed.meta;
  } catch {
    return null;
  }
}

export async function readSidecar(
  source: Source,
  id: string
): Promise<{ meta: ContentMeta; raw: unknown } | null> {
  try {
    const raw = await readFile(jsonPath(source, id), "utf-8");
    return JSON.parse(raw) as { meta: ContentMeta; raw: unknown };
  } catch {
    return null;
  }
}

export async function deleteContent(
  source: Source,
  id: string
): Promise<{ mdDeleted: boolean; jsonDeleted: boolean }> {
  const md = mdPath(source, id);
  const json = jsonPath(source, id);
  if (!resolve(md).startsWith(resolve(sourceDir(source)))) {
    throw new Error("Path traversal detected");
  }
  let mdDeleted = false;
  let jsonDeleted = false;
  try { await unlink(md); mdDeleted = true; } catch {}
  try { await unlink(json); jsonDeleted = true; } catch {}
  // Its pictures and video go with it (see lib/media.ts for the layout).
  await rm(join(sourceDir(source), "media", slug(source, id)), { recursive: true, force: true }).catch(() => {});
  return { mdDeleted, jsonDeleted };
}

export interface ListedEntry {
  source: Source;
  id: string;
  title: string;
  url: string;
  fetched_at: string;
  wordCount: number;
  fileSize: number;
  modified: string;
  mdPath: string;
}

const SOURCES: Source[] = ["youtube", "x", "instagram", "tiktok", "paper", "article"];

export async function listContent(source?: Source): Promise<ListedEntry[]> {
  const sources = source ? [source] : SOURCES;
  const entries: ListedEntry[] = [];
  for (const s of sources) {
    const dir = sourceDir(s);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".content.md")) continue;
      const meta = await metaFromFilename(s, f);
      if (!meta) continue;
      const mdFile = join(dir, f);
      const [md, info] = await Promise.all([
        readFile(mdFile, "utf-8"),
        stat(mdFile),
      ]);
      entries.push({
        source: s,
        id: meta.id,
        title: meta.title,
        url: meta.url,
        fetched_at: meta.fetched_at,
        wordCount: md.split(/\s+/).filter(Boolean).length,
        fileSize: info.size,
        modified: info.mtime.toISOString(),
        mdPath: mdFile,
      });
    }
  }
  return entries.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
  );
}

async function metaFromFilename(source: Source, filename: string): Promise<ContentMeta | null> {
  const id = filename.replace(/\.content\.md$/, "").replace(new RegExp(`^${source}_`), "");
  return readMeta(source, id);
}

export interface SearchHit {
  source: Source;
  id: string;
  title: string;
  score: number;
  wordCount: number;
  bestMatch: string;
  termHits: Record<string, number>;
}

export async function searchContent(
  query: string,
  limit: number,
  source?: Source,
  onlyId?: string
): Promise<SearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const sources = source ? [source] : SOURCES;
  const scored: SearchHit[] = [];

  for (const s of sources) {
    const dir = sourceDir(s);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith(".content.md")) continue;
      const id = f.replace(/\.content\.md$/, "").replace(new RegExp(`^${s}_`), "");
      if (onlyId && id !== onlyId) continue;

      const [body, meta] = await Promise.all([
        readFile(join(dir, f), "utf-8"),
        readMeta(s, id),
      ]);
      if (!meta) continue;

      const lower = body.toLowerCase();
      const words = body.split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      if (wordCount === 0) continue;

      const termHits: Record<string, number> = {};
      let totalHits = 0;
      let termsFound = 0;
      for (const term of terms) {
        let count = 0;
        let idx = 0;
        while ((idx = lower.indexOf(term, idx)) !== -1) {
          count++;
          idx += term.length;
        }
        termHits[term] = count;
        totalHits += count;
        if (count > 0) termsFound++;
      }
      if (totalHits === 0) continue;

      const tf = totalHits / wordCount;
      const coverage = termsFound / terms.length;
      const titleBonus = terms.some((t) => meta.title.toLowerCase().includes(t)) ? 0.2 : 0;
      const score = parseFloat((tf * 100 * coverage + titleBonus).toFixed(4));

      const chunkSize = 200;
      let bestChunk = "";
      let bestScore = 0;
      for (let i = 0; i < words.length; i += 100) {
        const chunk = words.slice(i, i + chunkSize).join(" ");
        const lowerChunk = chunk.toLowerCase();
        let hits = 0;
        for (const term of terms) {
          let idx = 0;
          while ((idx = lowerChunk.indexOf(term, idx)) !== -1) {
            hits++;
            idx += term.length;
          }
        }
        if (hits > bestScore) {
          bestScore = hits;
          bestChunk = chunk;
        }
      }

      scored.push({
        source: s,
        id,
        title: meta.title,
        score,
        wordCount,
        bestMatch: bestChunk,
        termHits,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function formatMarkdown(meta: ContentMeta, body: string): string {
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  return [
    "---",
    `source: ${meta.source}`,
    `id: ${meta.id}`,
    `url: ${meta.url}`,
    `title: ${escapeYaml(meta.title)}`,
    `fetched_at: ${meta.fetched_at}`,
    `content_hash: ${meta.content_hash}`,
    "---",
    "",
    `# ${meta.title}`,
    "",
    `**Source:** ${meta.url}`,
    "",
    `**Word Count:** ${wordCount.toLocaleString()}`,
    "",
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function escapeYaml(value: string): string {
  if (/[:#\n"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
