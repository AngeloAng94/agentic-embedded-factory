/**
 * Knowledge base retrieval.
 *
 * Deterministic scoring over the stored fragments (RTOS + category + tags +
 * lexical relevance) with an explicit token budget. The result carries an
 * evidence log line so tests and the UI can prove the KB was really queried.
 */

export type KbRtos = "zephyr" | "freertos" | "general";

export interface KbDocument {
  _id: string;
  rtos: KbRtos;
  category: string;
  title: string;
  content: string;
  tags?: string[];
}

export interface RetrievalQuery {
  rtos: "zephyr" | "freertos";
  userRequest: string;
  categories?: string[];
  budgetTokens?: number;
  maxDocs?: number;
}

export interface RetrievedDoc {
  id: string;
  rtos: KbRtos;
  category: string;
  title: string;
  score: number;
  tokens: number;
  excerpt: string;
}

export interface RetrievalResult {
  docs: RetrievedDoc[];
  considered: number;
  skippedOtherRtos: number;
  usedTokens: number;
  budgetTokens: number;
  queryTerms: string[];
  /** Single line evidence record, safe to store in a run log. */
  log: string;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","for","with","that","this","from","into","using","use","please",
  "voglio","che","con","per","una","uno","il","lo","la","i","gli","le","di","da","su","in",
  "del","della","dei","delle","e","o","al","alla","code","file","project","progetto","add",
  "aggiungi","crea","make","build","implement","implementa","should","must","need","needs",
]);

export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

const DEFAULT_BUDGET_TOKENS = 800;
const DEFAULT_MAX_DOCS = 4;

export function scoreDocument(doc: KbDocument, terms: string[], categories: string[]): number {
  const tags = (doc.tags ?? []).map((tag) => tag.toLowerCase());
  const titleTerms = new Set(tokenize(doc.title));
  const contentTerms = new Set(tokenize(doc.content));
  const category = doc.category.toLowerCase();

  let score = 0;
  if (doc.rtos !== "general") score += 3;
  else score += 1;
  if (categories.some((value) => value.toLowerCase() === category)) score += 2;

  for (const term of terms) {
    if (tags.some((tag) => tag.includes(term))) score += 3;
    if (titleTerms.has(term)) score += 2;
    if (contentTerms.has(term)) score += 1;
  }
  return score;
}

export function retrieveKnowledge(
  documents: KbDocument[],
  query: RetrievalQuery,
): RetrievalResult {
  const budgetTokens = query.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxDocs = query.maxDocs ?? DEFAULT_MAX_DOCS;
  const terms = [...new Set(tokenize(query.userRequest))];
  const categories = query.categories ?? [];

  const candidates: RetrievedDoc[] = [];
  let skippedOtherRtos = 0;

  for (const doc of documents) {
    if (doc.rtos !== "general" && doc.rtos !== query.rtos) {
      skippedOtherRtos += 1;
      continue;
    }
    const score = scoreDocument(doc, terms, categories);
    candidates.push({
      id: doc._id,
      rtos: doc.rtos,
      category: doc.category,
      title: doc.title,
      score,
      tokens: estimateTokens(doc.content),
      excerpt: doc.content.trim(),
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });

  const selected: RetrievedDoc[] = [];
  let usedTokens = 0;
  const minimumScore = terms.length === 0 ? 1 : 2;

  for (const candidate of candidates) {
    if (selected.length >= maxDocs) break;
    if (candidate.score < minimumScore) continue;
    if (usedTokens + candidate.tokens > budgetTokens) continue;
    selected.push(candidate);
    usedTokens += candidate.tokens;
  }

  const log =
    `[kb] rtos=${query.rtos} terms=${terms.slice(0, 8).join("|") || "-"} ` +
    `considered=${candidates.length} skipped_other_rtos=${skippedOtherRtos} ` +
    `selected=${selected.length} tokens=${usedTokens}/${budgetTokens} ` +
    `ids=${selected.map((doc) => doc.id).join(",") || "-"}`;

  return {
    docs: selected,
    considered: candidates.length,
    skippedOtherRtos,
    usedTokens,
    budgetTokens,
    queryTerms: terms,
    log,
  };
}

export function formatKnowledgeBlock(docs: RetrievedDoc[]): string {
  if (docs.length === 0) return "";
  return docs
    .map(
      (doc) =>
        `### ${doc.title} (${doc.rtos}/${doc.category}, score ${doc.score})\n${doc.excerpt}`,
    )
    .join("\n\n");
}
