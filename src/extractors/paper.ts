import type { Extractor } from "../types.js";

// Matches new-style (YYMM.NNNNN[vN]) and old-style (category/NNNNNNN) arxiv IDs.
const ARXIV_URL_RE =
  /arxiv\.org\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5}))(?:v\d+)?(?:\.pdf)?/i;

function decode(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pickFirst(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? decode(m[1]) : null;
}

function pickAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decode(m[1]));
  return out;
}

const paper: Extractor<"paper"> = {
  source: "paper",

  matches(url: string): boolean {
    return ARXIV_URL_RE.test(url);
  },

  extractId(url: string): string {
    const m = url.match(ARXIV_URL_RE);
    if (!m) throw new Error("Could not extract arxiv ID");
    return m[1];
  },

  async fetch(url: string, signal: AbortSignal) {
    const id = this.extractId(url);
    const apiUrl = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const res = await fetch(apiUrl, { signal, headers: { Accept: "application/atom+xml" } });
    if (!res.ok) throw new Error(`arxiv API returned ${res.status}`);
    const xml = await res.text();

    // Pull the single <entry>
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) throw new Error("arxiv API returned no entry — invalid ID?");
    const entry = entryMatch[1];

    const title = pickFirst(entry, "title") ?? `arxiv:${id}`;
    const summary = pickFirst(entry, "summary") ?? "";
    const published = pickFirst(entry, "published") ?? "";
    const updated = pickFirst(entry, "updated") ?? "";

    // Authors: <author><name>...</name></author>
    const authors = pickAll(entry, "author")
      .map((a) => {
        const nameMatch = a.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
        return nameMatch ? decode(nameMatch[1]) : null;
      })
      .filter(Boolean) as string[];

    // Categories: <category term="cs.LG" ... />
    const categories = Array.from(
      entry.matchAll(/<category[^>]*term="([^"]+)"/g)
    ).map((m) => m[1]);

    const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    const doi = doiMatch ? decode(doiMatch[1]) : null;

    const pdfUrl = `https://arxiv.org/pdf/${id}.pdf`;
    const absUrl = `https://arxiv.org/abs/${id}`;

    const lines: string[] = [
      `**Authors:** ${authors.join(", ") || "unknown"}`,
      `**Published:** ${published || "unknown"}`,
      `**Categories:** ${categories.join(", ") || "—"}`,
    ];
    if (doi) lines.push(`**DOI:** ${doi}`);
    lines.push("", "## Abstract", "", summary);
    const content = lines.join("\n");

    return {
      title,
      content,
      source_specific: {
        arxivId: id,
        authors,
        categories,
        published,
        updated,
        doi,
        pdfUrl,
        absUrl,
      },
      raw: { atomEntry: entry },
    };
  },
};

export default paper;
