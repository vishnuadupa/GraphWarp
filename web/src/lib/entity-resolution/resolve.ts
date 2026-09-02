/**
 * Cross-document entity resolution — pure scoring logic, no IO.
 *
 * Given a user's full entity set (name, type, degree, optional embedding),
 * proposes merge pairs scored by two independent signals:
 *
 *   1. name similarity  — token overlap with prefix-aware matching + normalized
 *                         Levenshtein, always available
 *   2. embedding cosine — only for entities that actually carry an `embedding`
 *                         property (null-safe: missing embeddings just drop the
 *                         signal for that pair, they never fail the pass)
 *
 * Proposals land in one of two tiers: `high` (safe to auto-merge) and `medium`
 * (flagged for human review). Everything below the review floor is dropped.
 *
 * Self-check: `node src/lib/entity-resolution/resolve.ts` (Node 24 strips types).
 */

export interface EntityRecord {
  name: string;
  type: string;
  degree: number;
  embedding?: number[] | null;
}

export interface MergeSignals {
  /** 0..1 name-only similarity */
  nameSimilarity: number;
  /** raw cosine of the two name embeddings, or null when either lacks one */
  embeddingSimilarity: number | null;
  /** fraction of the shorter name's tokens found in the longer one */
  tokenContainment: number;
  /** names identical after lowercasing + punctuation stripping */
  exactNormalized: boolean;
  /** the two nodes carry different non-generic `type` values */
  typeConflict: boolean;
}

export interface MergeProposal {
  canonical: string;
  canonicalType: string;
  duplicate: string;
  duplicateType: string;
  /** type the merged node will keep (canonical's, unless it is generic) */
  type: string;
  confidence: number;
  tier: 'high' | 'medium';
  signals: MergeSignals;
  reasoning: string;
}

export interface ResolveOptions {
  /** cosine at/above which embeddings alone justify auto-merge. Default 0.92 */
  embeddingHigh?: number;
  /** name similarity at/above which names alone justify auto-merge. Default 0.95 */
  nameHigh?: number;
  /** confidence floor below which a pair is not reported at all. Default 0.55 */
  reviewFloor?: number;
  /**
   * A token appearing in more than this many entities is treated as too generic
   * to block on (e.g. "inc", "the"). Default 200.
   */
  maxBlockSize?: number;
  /** hard cap on scored pairs, protects against pathological graphs. Default 200_000 */
  maxPairs?: number;
}

const DEFAULTS: Required<ResolveOptions> = {
  embeddingHigh: 0.92,
  nameHigh: 0.95,
  reviewFloor: 0.55,
  maxBlockSize: 200,
  maxPairs: 200_000,
};

const GENERIC_TYPES = new Set(['', 'entity', 'unknown', 'other', 'thing']);

// ---------------------------------------------------------------- string bits

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeName(s);
  return n ? n.split(' ') : [];
}

/** 1.0 for identical tokens, 0.85 for a prefix match ("corp" ~ "corporation"), else 0. */
function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  return 0;
}

/** Normalized Levenshtein similarity, 0..1. */
export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // ponytail: O(n*m) DP on names (short strings); switch to a bounded/banded
  // variant only if entity names ever get long enough to matter.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Greedy one-to-one token alignment.
 * Returns the total match score, the match count, and the containment ratio
 * (matched / tokens in the shorter name — 1.0 when one name's tokens are a
 * subset of the other's, the `resolveAliases` signal generalized pairwise).
 */
function alignTokens(a: string[], b: string[]): { score: number; count: number; containment: number } {
  const used = new Array<boolean>(b.length).fill(false);
  let score = 0;
  let count = 0;
  for (const ta of a) {
    let bestIdx = -1;
    let best = 0;
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue;
      const s = tokenScore(ta, b[j]);
      if (s > best) {
        best = s;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = true;
      score += best;
      count++;
    }
  }
  const shorter = Math.min(a.length, b.length) || 1;
  return { score, count, containment: count / shorter };
}

/** Combined name-only similarity in 0..1, plus the raw containment signal. */
export function nameSimilarity(a: string, b: string): { similarity: number; containment: number; exact: boolean } {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return { similarity: 1, containment: 1, exact: true };

  const ta = tokenize(a);
  const tb = tokenize(b);
  const { score, count, containment } = alignTokens(ta, tb);

  // Jaccard-style: matched mass over the union of tokens.
  const union = ta.length + tb.length - count;
  const jaccard = union > 0 ? score / union : 0;

  // A single-token name contained in a longer one ("Acme" ⊂ "Acme Corp") is a
  // real but weak signal — many people/orgs share a first token — so it is
  // discounted harder than a multi-token containment.
  const containmentWeight = Math.min(ta.length, tb.length) >= 2 ? 0.85 : 0.6;

  return {
    similarity: Math.max(jaccard, containment * containmentWeight, levenshteinRatio(na, nb)),
    containment,
    exact: false,
  };
}

// ------------------------------------------------------------------ embedding

/** Cosine similarity. Returns null for missing, empty or mismatched vectors. */
export function cosineSimilarity(a?: number[] | null, b?: number[] | null): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Map raw cosine onto 0..1 — below 0.70 carries no information for short names. */
function embeddingScore(cos: number): number {
  return Math.max(0, Math.min(1, (cos - 0.7) / 0.3));
}

// ------------------------------------------------------------------ proposals

function isGeneric(t: string): boolean {
  return GENERIC_TYPES.has((t || '').toLowerCase());
}

/**
 * Canonical = most connected node; ties broken by the longer (more complete)
 * name, then alphabetically — so the choice is deterministic and re-runnable.
 */
function pickCanonical(a: EntityRecord, b: EntityRecord): [EntityRecord, EntityRecord] {
  if (a.degree !== b.degree) return a.degree > b.degree ? [a, b] : [b, a];
  if (a.name.length !== b.name.length) return a.name.length > b.name.length ? [a, b] : [b, a];
  return a.name <= b.name ? [a, b] : [b, a];
}

/**
 * Blocking: only pairs sharing a non-generic token (or where one name is the
 * acronym of the other) are ever scored.
 *
 * ponytail: this is the accuracy ceiling — two names with no shared token and
 * no acronym link (e.g. "Big Blue" / "IBM") are never even compared, no matter
 * how close their embeddings are. Upgrade path if that starts mattering: swap
 * this block for a per-entity `db.index.vector.queryNodes` top-k lookup against
 * the existing `entity_name_embeddings` index.
 */
function candidatePairs(entities: EntityRecord[], maxBlockSize: number, maxPairs: number): Array<[number, number]> {
  const byToken = new Map<string, number[]>();
  const byAcronym = new Map<string, number[]>();

  entities.forEach((e, i) => {
    const toks = tokenize(e.name);
    for (const t of new Set(toks)) {
      const arr = byToken.get(t);
      if (arr) arr.push(i);
      else byToken.set(t, [i]);
    }
    if (toks.length >= 2) {
      const acr = toks.map((t) => t[0]).join('');
      const arr = byAcronym.get(acr);
      if (arr) arr.push(i);
      else byAcronym.set(acr, [i]);
    }
    // A single-token name is itself a potential acronym of a multi-token one.
    if (toks.length === 1) {
      const arr = byAcronym.get(toks[0]);
      if (arr) arr.push(i);
      else byAcronym.set(toks[0], [i]);
    }
  });

  const seen = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const push = (i: number, j: number) => {
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = lo * entities.length + hi;
    if (lo === hi || seen.has(key)) return;
    seen.add(key);
    pairs.push([lo, hi]);
  };

  for (const buckets of [byToken, byAcronym]) {
    for (const idxs of buckets.values()) {
      if (idxs.length < 2 || idxs.length > maxBlockSize) continue;
      for (let x = 0; x < idxs.length; x++) {
        for (let y = x + 1; y < idxs.length; y++) {
          if (pairs.length >= maxPairs) return pairs;
          push(idxs[x], idxs[y]);
        }
      }
    }
  }
  return pairs;
}

export function proposeMerges(entities: EntityRecord[], opts: ResolveOptions = {}): MergeProposal[] {
  const o = { ...DEFAULTS, ...opts };
  const pairs = candidatePairs(entities, o.maxBlockSize, o.maxPairs);
  const proposals: MergeProposal[] = [];

  for (const [i, j] of pairs) {
    const ea = entities[i];
    const eb = entities[j];

    const { similarity: nameSim, containment, exact } = nameSimilarity(ea.name, eb.name);
    const cos = cosineSimilarity(ea.embedding, eb.embedding);

    const confidence = cos === null
      ? nameSim
      : Math.max(nameSim, 0.5 * nameSim + 0.5 * embeddingScore(cos));

    const typeConflict =
      !isGeneric(ea.type) && !isGeneric(eb.type) && ea.type.toLowerCase() !== eb.type.toLowerCase();

    let tier: 'high' | 'medium' =
      exact ||
      nameSim >= o.nameHigh ||
      (cos !== null && cos >= o.embeddingHigh && nameSim >= 0.5)
        ? 'high'
        : 'medium';

    // Different declared types is a strong "these are not the same thing"
    // signal — never auto-merge across it, leave it to a human.
    let score = confidence;
    if (typeConflict && !exact) {
      tier = 'medium';
      score = confidence * 0.8;
    }
    if (score < o.reviewFloor) continue;

    const [canon, dup] = pickCanonical(ea, eb);
    const reasons: string[] = [];
    if (exact) reasons.push('names identical after normalization');
    else reasons.push(`name similarity ${nameSim.toFixed(2)} (token containment ${containment.toFixed(2)})`);
    if (cos !== null) reasons.push(`embedding cosine ${cos.toFixed(3)}`);
    else reasons.push('no embedding on one or both nodes');
    if (typeConflict) reasons.push(`type conflict: ${canon.type} vs ${dup.type} — review required`);

    proposals.push({
      canonical: canon.name,
      canonicalType: canon.type,
      duplicate: dup.name,
      duplicateType: dup.type,
      type: isGeneric(canon.type) ? dup.type : canon.type,
      confidence: Number(score.toFixed(4)),
      tier,
      signals: {
        nameSimilarity: Number(nameSim.toFixed(4)),
        embeddingSimilarity: cos === null ? null : Number(cos.toFixed(4)),
        tokenContainment: Number(containment.toFixed(4)),
        exactNormalized: exact,
        typeConflict,
      },
      reasoning: reasons.join('; '),
    });
  }

  demoteAmbiguous(proposals);
  proposals.sort((a, b) => b.confidence - a.confidence || a.canonical.localeCompare(b.canonical));
  return proposals;
}

/**
 * "John" is a high-confidence match for both "John Smith" and "John Doe", but
 * those two are not matches for each other — so "John" is an ambiguous mention,
 * not a duplicate. Demote every high proposal that touches such an entity.
 */
function demoteAmbiguous(proposals: MergeProposal[]): void {
  const partners = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = partners.get(a);
    if (set) set.add(b);
    else partners.set(a, new Set([b]));
  };
  for (const p of proposals) {
    if (p.tier !== 'high' || p.signals.exactNormalized) continue;
    link(p.duplicate, p.canonical);
    link(p.canonical, p.duplicate);
  }

  const ambiguous = new Set<string>();
  for (const [name, set] of partners) {
    const others = [...set];
    for (let x = 0; x < others.length && !ambiguous.has(name); x++) {
      for (let y = x + 1; y < others.length; y++) {
        if (nameSimilarity(others[x], others[y]).similarity < 0.7) {
          ambiguous.add(name);
          break;
        }
      }
    }
  }

  for (const p of proposals) {
    if (p.tier !== 'high' || p.signals.exactNormalized) continue;
    if (ambiguous.has(p.duplicate) || ambiguous.has(p.canonical)) {
      p.tier = 'medium';
      p.reasoning += '; ambiguous — matches multiple dissimilar entities';
    }
  }
}

/**
 * Resolve merge pairs through a union-find so chains collapse to one survivor
 * ("Acme" → "Acme Corp" → "Acme Corporation" merges all three into the last).
 * Returns ordered (canonical, duplicate) pairs safe to apply sequentially.
 */
export function resolveChains(
  pairs: Array<{ canonical: string; duplicate: string }>,
): Array<{ canonical: string; duplicate: string }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p === x) return x;
    p = find(p);
    parent.set(x, p);
    return p;
  };

  const out: Array<{ canonical: string; duplicate: string }> = [];
  for (const { canonical, duplicate } of pairs) {
    const c = find(canonical);
    const d = find(duplicate);
    if (c === d) continue;
    parent.set(d, c);
    out.push({ canonical: c, duplicate });
    // Anything already merged into `duplicate` now points at `c` too.
    for (const p of out) if (p.canonical === duplicate) p.canonical = c;
  }
  return out;
}

// ------------------------------------------------------------------ selfcheck

/* c8 ignore start */
if (process.argv[1]?.replace(/\\/g, '/').endsWith('entity-resolution/resolve.ts')) {
  // Deliberately dependency-free (no assert import) so this file stays a plain
  // module Next can bundle, and `node resolve.ts` runs it with no setup.
  const fail = (msg: string): never => {
    throw new Error(`self-check failed: ${msg}`);
  };
  const ok = {
    equal: (a: unknown, b: unknown, m = `${JSON.stringify(a)} !== ${JSON.stringify(b)}`) =>
      a === b ? undefined : fail(m),
    deepEqual: (a: unknown, b: unknown, m = 'deepEqual') =>
      JSON.stringify(a) === JSON.stringify(b) ? undefined : fail(`${m}: got ${JSON.stringify(a)}`),
    ok: (v: unknown, m = 'expected truthy') => (v ? undefined : fail(m)),
  };

  ok.equal(normalizeName('Acme  Corp.'), 'acme corp');
  ok.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  ok.equal(cosineSimilarity([1, 0], null), null, 'missing embedding must not throw');
  ok.equal(cosineSimilarity([1, 0], [1, 0, 0]), null, 'dimension mismatch must not throw');
  ok.equal(cosineSimilarity([0, 0], [1, 0]), null, 'zero vector must not divide by zero');

  const e = (name: string, type = 'Organization', degree = 1, embedding?: number[]): EntityRecord =>
    ({ name, type, degree, embedding });

  // Case-only difference → high tier, same as dedup v0.
  let p = proposeMerges([e('Alice', 'Person', 5), e('alice', 'Person', 1)]);
  ok.equal(p.length, 1);
  ok.equal(p[0].tier, 'high');
  ok.equal(p[0].canonical, 'Alice', 'higher-degree node wins canonical');

  // Abbreviation with no embeddings → reported, but review-only.
  p = proposeMerges([e('Acme Corp', 'Organization', 4), e('Acme', 'Organization', 1)]);
  ok.equal(p.length, 1);
  ok.equal(p[0].tier, 'medium', 'bare token subset must not auto-merge');
  ok.equal(p[0].signals.embeddingSimilarity, null);

  // Same pair, now with near-identical embeddings → promoted to auto-merge.
  const v1 = [1, 0, 0];
  const v2 = [0.99, 0.14, 0];
  p = proposeMerges([e('Acme Corp', 'Organization', 4, v1), e('Acme', 'Organization', 1, v2)]);
  ok.equal(p[0].tier, 'high', 'embedding cosine above threshold promotes the pair');
  ok.ok((p[0].signals.embeddingSimilarity ?? 0) > 0.92);

  // Ambiguous first name must not auto-merge into two different people.
  p = proposeMerges([e('John', 'Person', 1, v1), e('John Smith', 'Person', 3, v1), e('John Doe', 'Person', 3, v1)]);
  ok.ok(
    p.filter((x) => x.tier === 'high' && (x.duplicate === 'John' || x.canonical === 'John')).length === 0,
    'ambiguous mention must be demoted to review',
  );

  // Type conflict never auto-merges.
  p = proposeMerges([e('Mercury', 'Person', 3, v1), e('Mercury', 'Planet', 1, v1)]);
  ok.equal(p.length, 1);
  ok.equal(p[0].signals.typeConflict, true);

  // Unrelated names are never even proposed.
  ok.equal(proposeMerges([e('Acme Corp'), e('Globex Industries')]).length, 0);

  // Chains collapse onto one survivor.
  ok.deepEqual(
    resolveChains([
      { canonical: 'Acme Corporation', duplicate: 'Acme Corp' },
      { canonical: 'Acme Corp', duplicate: 'Acme' },
    ]),
    [
      { canonical: 'Acme Corporation', duplicate: 'Acme Corp' },
      { canonical: 'Acme Corporation', duplicate: 'Acme' },
    ],
  );

  console.log('resolve.ts self-check passed');
}
/* c8 ignore stop */
