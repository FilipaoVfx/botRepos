import crypto from "node:crypto";

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Sanitize text for Pinecone metadata. Removes invalid Unicode characters.
 */
export function sanitizeForPinecone(text) {
  if (!text || typeof text !== "string") return "";
  // Remove lone surrogates and other invalid Unicode
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // lone high surrogates
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") // lone low surrogates
    .replace(/\u0000/g, "") // null bytes
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // control chars
    .normalize("NFC");
}

/**
 * Chunk text with overlap. Splits on sentence boundaries when possible.
 */
export function chunkText(text, options = {}) {
  const {
    maxChars = DEFAULT_CHUNK_SIZE,
    overlap = DEFAULT_CHUNK_OVERLAP,
  } = options;

  if (!text || typeof text !== "string") return [];
  const clean = text.trim();
  if (clean.length === 0) return [];

  if (clean.length <= maxChars) {
    return [{ text: clean, start_offset: 0, end_offset: clean.length }];
  }

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);

    // Try to split at sentence boundary
    if (end < clean.length) {
      const lastPeriod = clean.lastIndexOf(".", end);
      const lastNewline = clean.lastIndexOf("\n", end);
      const splitPoint = Math.max(lastPeriod, lastNewline);

      if (splitPoint > start + maxChars * 0.5) {
        end = splitPoint + 1;
      }
    }

    const chunkText = clean.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        start_offset: start,
        end_offset: end,
      });
    }

    start = end - overlap;
    if (start >= clean.length - overlap) break;
  }

  return chunks;
}

/**
 * Build enriched content from a bookmark record.
 */
export function buildBookmarkContent(bookmark) {
  const parts = [];

  if (bookmark.text_content) {
    parts.push(bookmark.text_content);
  }

  if (bookmark.author_name) {
    parts.push(`Author: ${bookmark.author_name} (@${bookmark.author_username || ""})`);
  }

  if (bookmark.source_url) {
    parts.push(`URL: ${bookmark.source_url}`);
  }

  if (bookmark.links && bookmark.links.length > 0) {
    parts.push(`Links: ${bookmark.links.join(", ")}`);
  }

  if (bookmark.first_comment_links && bookmark.first_comment_links.length > 0) {
    parts.push(`First comment links: ${bookmark.first_comment_links.join(", ")}`);
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Derive a title from a bookmark.
 */
export function deriveBookmarkTitle(bookmark) {
  const text = bookmark.text_content || "";
  if (text.length > 0) {
    const firstSentence = text.split(/[.!?\n]/)[0].trim();
    if (firstSentence.length > 5 && firstSentence.length <= 120) {
      return firstSentence;
    }
    if (firstSentence.length > 120) {
      return firstSentence.slice(0, 117) + "...";
    }
  }

  if (bookmark.author_username) {
    return `Bookmark by @${bookmark.author_username}`;
  }

  return "Untitled bookmark";
}

/**
 * Extract tags from bookmark content using simple heuristics.
 */
export function extractBookmarkTags(bookmark) {
  const tags = new Set();
  const text = (bookmark.text_content || "").toLowerCase();

  // Detect tech keywords
  const techPatterns = [
    /\b(react|vue|angular|svelte|nextjs?|nuxt|astro)\b/i,
    /\b(node|deno|bun|python|rust|go|typescript|javascript)\b/i,
    /\b(api|rest|graphql|grpc|websocket)\b/i,
    /\b(docker|kubernetes|k8s|aws|gcp|azure|vercel|netlify)\b/i,
    /\b(postgres|mysql|mongo|redis|supabase|firebase)\b/i,
    /\b(ai|ml|llm|gpt|openai|anthropic|claude|embedding|rag)\b/i,
    /\b(agent|automation|workflow|pipeline|n8n|zapier)\b/i,
    /\b(tutorial|guide|howto|documentation)\b/i,
  ];

  for (const pattern of techPatterns) {
    const match = text.match(pattern);
    if (match) {
      tags.add(match[1].toLowerCase());
    }
  }

  // Add author as tag
  if (bookmark.author_username) {
    tags.add(`@${bookmark.author_username}`);
  }

  return [...tags];
}

/**
 * Chunk a README by headings, preserving structure.
 */
export function chunkReadmeByHeadings(content, options = {}) {
  const { maxChars = 2000 } = options;

  if (!content || typeof content !== "string") return [];
  const clean = content.trim();
  if (clean.length === 0) return [];

  // Split by markdown headings
  const headingRegex = /^(#{1,6}\s+.+)$/gm;
  const sections = [];
  let lastEnd = 0;
  let lastHeading = "";
  let match;

  while ((match = headingRegex.exec(clean)) !== null) {
    if (match.index > lastEnd) {
      const text = clean.slice(lastEnd, match.index).trim();
      if (text.length > 0) {
        sections.push({ heading: lastHeading, text });
      }
    }
    lastHeading = match[1].replace(/^#+\s*/, "").trim();
    lastEnd = match.index + match[0].length;
  }

  // Last section
  if (lastEnd < clean.length) {
    const text = clean.slice(lastEnd).trim();
    if (text.length > 0) {
      sections.push({ heading: lastHeading, text });
    }
  }

  // If no headings found, treat as single section
  if (sections.length === 0) {
    sections.push({ heading: "", text: clean });
  }

  // Sub-chunk large sections
  const chunks = [];
  let chunkIdx = 0;

  for (const section of sections) {
    if (section.text.length <= maxChars) {
      chunks.push({
        text: section.text,
        heading: section.heading,
        chunk_index: chunkIdx++,
      });
    } else {
      const subChunks = chunkText(section.text, {
        maxChars,
        overlap: DEFAULT_CHUNK_OVERLAP,
      });
      for (const sub of subChunks) {
        chunks.push({
          text: sub.text,
          heading: section.heading,
          chunk_index: chunkIdx++,
        });
      }
    }
  }

  return chunks;
}

/**
 * Generate a content hash for change detection.
 */
export function contentHash(text) {
  return crypto.createHash("md5").update(text || "").digest("hex");
}

/**
 * Build enriched content from a README record.
 */
export function buildReadmeContent(readme) {
  const parts = [];

  if (readme.repo_slug) {
    parts.push(`Repository: ${readme.repo_slug}`);
  }

  if (readme.repo_url) {
    parts.push(`URL: ${readme.repo_url}`);
  }

  if (readme.content) {
    parts.push(readme.content);
  }

  return parts.filter(Boolean).join("\n\n");
}
