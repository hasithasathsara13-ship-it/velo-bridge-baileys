/**
 * Catalog-driven product matching, shared by the reply bot (which photos to
 * send) and the follow-up engine (which product a chat was about).
 *
 * Nothing in here knows about any particular business or product. Which words
 * identify a product is learned from the shop's OWN catalog every time:
 *   - a word that appears in only ONE product name ("rib", "dolphin", "box",
 *     "cut", "17") points at that product;
 *   - a word shared by several product names ("short", "panties", "bra") only
 *     narrows the choice and can never pick a product on its own.
 * When the text fits two products equally well the answer is "unknown" — the
 * caller then asks the customer instead of guessing a wrong product.
 */

export type NamedProduct = { name: string; description?: string | null };

/**
 * Words that never identify a product in any shop: units, pricing, sizing and
 * conversational filler (English / Singlish / Sinhala / Tamil).
 */
const STOP_WORDS = new Set([
  // units / pricing / sizing
  "price", "cost", "rate", "rs", "pack", "pc", "pcs", "piece", "item", "qty", "quantity",
  "size", "inch", "cm", "mm", "colour", "color", "material", "free", "delivery", "offer",
  "promotion", "new", "total", "kiyada", "keeyada", "gana", "mila",
  // English filler
  "the", "and", "for", "with", "this", "that", "these", "those", "what", "which", "how", "much",
  "is", "are", "can", "could", "would", "please", "plz", "pls", "want", "need", "like", "about",
  "info", "detail", "details", "more", "send", "show", "see", "photo", "pic", "picture", "image",
  "hi", "hello", "hey", "ok", "okay", "thank", "thanks", "yes", "no", "you", "your", "our", "me",
  "my", "of", "to", "in", "on", "it", "a", "an", "or", "get", "have", "has",
  // Singlish filler
  "eka", "ekak", "ekai", "ona", "oni", "one", "onee", "mata", "denna", "danna", "ewanna", "ewala",
  "ewanne", "balanna", "balamu", "pennanna", "thiyanawa", "thiyanawada", "thiyenawada", "thiyeda",
  "meka", "mekai", "mewa", "ara", "kalin", "dr", "mis", "nane", "nadda", "nedda", "hari", "ow", "ou",
  "wistara", "kiyanna", "kiyannako", "puluwanda", "mokakda", "monawada",
]);

function normToken(raw: string): string {
  let s = raw.toLowerCase();
  if (/^\d+$/.test(s)) return s;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:ch|sh|x|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

function tokenize(text: string): string[] {
  const cleaned = String(text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .toLowerCase()
    .normalize("NFC");
  return (cleaned.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .map(normToken)
    .filter((t) => t && !STOP_WORDS.has(t));
}

function compact(text: string): string {
  return String(text ?? "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

type IndexedCatalog<T> = {
  entries: Array<{ product: T; tokens: string[]; nameCompact: string }>;
  df: Map<string, number>;
};

const catalogCache = new WeakMap<object, IndexedCatalog<NamedProduct>>();

function indexCatalog<T extends NamedProduct>(products: T[]): IndexedCatalog<T> {
  const cached = catalogCache.get(products);
  if (cached) return cached as unknown as IndexedCatalog<T>;
  const entries = products
    .filter((p) => p?.name?.trim())
    .map((product) => ({
      product,
      tokens: [...new Set(tokenize(product.name))],
      nameCompact: compact(product.name.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "")),
    }));
  const df = new Map<string, number>();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const index = { entries, df };
  catalogCache.set(products, index as unknown as IndexedCatalog<NamedProduct>);
  return index;
}

export type ProductMatchScore<T> = { product: T; score: number; anchored: boolean };

/** Every product the text points at, best first. Only anchored matches can be trusted. */
export function rankProductMatches<T extends NamedProduct>(text: string, products: T[] | null | undefined): ProductMatchScore<T>[] {
  if (!products?.length || !String(text ?? "").trim()) return [];
  const { entries, df } = indexCatalog(products);
  const qTokens = tokenize(text);
  if (!qTokens.length) return [];
  const qSet = new Set(qTokens);
  const qCompact = compact(text);
  const out: ProductMatchScore<T>[] = [];

  for (const { product, tokens, nameCompact } of entries) {
    let score = 0;
    let anchored = false;
    let matchedCount = 0;
    let numericAnchor = false;
    const matched = new Set<string>();

    const weight = (tok: string) => {
      const n = df.get(tok) ?? 1;
      return n <= 1 ? 10 : 10 / n;
    };
    const credit = (tok: string, factor: number, canAnchor: boolean = true) => {
      if (matched.has(tok)) return;
      matched.add(tok);
      matchedCount += 1;
      score += weight(tok) * factor;
      if (canAnchor && (df.get(tok) ?? 1) <= 1) {
        if (/^\d+$/.test(tok)) numericAnchor = tok.length >= 2 || numericAnchor;
        else if (tok.length >= 2) anchored = true;
      }
    };

    for (const tok of tokens) {
      if (qSet.has(tok)) {
        credit(tok, 1, true);
      } else if (tok.length >= 7 && !/^\d+$/.test(tok)) {
        // Spelling slips for long words only ("stretchable" / "strechble").
        // Words < 7 chars (e.g. "short" vs "sport") must NEVER fuzzy match!
        const limit = tok.length >= 9 ? 2 : 1;
        if (qTokens.some((q) => q.length >= 6 && editDistance(q, tok) <= limit)) {
          credit(tok, 0.7, false); // Fuzzy match gives partial score but NEVER anchors
        }
      }
    }
    // Words written together or apart ("popcorn" / "pop corn", "vcut" / "v cut").
    for (let i = 0; i + 1 < tokens.length; i++) {
      const joined = tokens[i] + tokens[i + 1];
      if (joined.length >= 4 && qCompact.includes(joined) && !(matched.has(tokens[i]) && matched.has(tokens[i + 1]))) {
        credit(tokens[i], 1, true);
        credit(tokens[i + 1], 1, true);
        if ((df.get(tokens[i]) ?? 1) <= 1 || (df.get(tokens[i + 1]) ?? 1) <= 1) anchored = true;
      }
    }
    // A number unique to one product ("17") only counts next to another word of
    // that product ("17 short"), so house numbers / colour numbers never match.
    if (numericAnchor && matchedCount >= 2) anchored = true;
    // The whole product name written out.
    if (nameCompact.length >= 4 && qCompact.includes(nameCompact)) {
      score += 100;
      anchored = true;
    }
    if (score > 0) out.push({ product, score, anchored });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The one product the text is about, or undefined when it names none or is
 * ambiguous between two equally good candidates.
 */
export function matchProductInText<T extends NamedProduct>(text: string, products: T[] | null | undefined): T | undefined {
  const ranked = rankProductMatches(text, products).filter((r) => r.anchored);
  if (!ranked.length) return undefined;
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 0.5) return undefined;
  return ranked[0].product;
}

/** How many different products a message clearly names (3+ means it is a menu / list). */
export function countNamedProducts<T extends NamedProduct>(text: string, products: T[] | null | undefined): number {
  return rankProductMatches(text, products).filter((r) => r.anchored).length;
}

const SKIP_ROW = /^(?:https?:\/\/\S+|wa-media:\S+)$|^\[(?:interest|checkout|custom)\s+reminder\]/i;
const BOT_UNSOLICITED_SUGGESTION = /\b(?:instead|other\s*items|also\s*(?:have|recommend|available)|might\s*like|recommend(?:ed)?\s*for\s*you)\b|වෙනත්\s*items|වෙන\s*(?:items?|ඒවා)/i;

function isCustomerRow(m: { role?: string; from?: string }): boolean {
  if (m.role) return m.role === "user";
  if (m.from) return m.from === "customer";
  return false;
}

/**
 * The product the conversation is currently about, giving STRICT priority to
 * what the CUSTOMER explicitly expressed interest in:
 * 1. Scans customer messages newest-first; the latest unambiguous match wins.
 * 2. Only when no customer message unambiguously names a product (and
 *    `customerOnly` is false), checks a single-product bot response directly
 *    answering an adjacent/matching customer inquiry.
 */
export function findDiscussedProduct<T extends NamedProduct>(
  messagesNewestFirst: Array<{ role?: string; from?: string; content?: string | null; text?: string | null }>,
  products: T[] | null | undefined,
  opts: { limit?: number; resolve?: (text: string) => T | undefined; customerOnly?: boolean } = {},
): T | undefined {
  if (!products?.length) return undefined;
  const limit = opts.limit ?? 14;
  const window = messagesNewestFirst.slice(0, limit * 2);

  let seenCust = 0;
  for (const m of window) {
    if (!isCustomerRow(m)) continue;
    const text = String(m.content ?? m.text ?? "").trim();
    if (!text || SKIP_ROW.test(text)) continue;
    if (++seenCust > limit) break;
    if (countNamedProducts(text, products) >= 3) continue;
    const hit = opts.resolve ? opts.resolve(text) : matchProductInText(text, products);
    if (hit) return hit;
  }

  if (opts.customerOnly) return undefined;

  let seenBot = 0;
  for (let i = 0; i < window.length; i++) {
    const m = window[i];
    if (isCustomerRow(m)) continue;
    const text = String(m.content ?? m.text ?? "").trim();
    if (!text || SKIP_ROW.test(text) || /^\[ORDER_CREATED\]/i.test(text)) continue;
    if (++seenBot > limit) break;
    if (BOT_UNSOLICITED_SUGGESTION.test(text)) continue;
    if (countNamedProducts(text, products) !== 1) continue;
    const hit = opts.resolve ? opts.resolve(text) : matchProductInText(text, products);
    if (!hit) continue;

    const hitTokens = new Set(tokenize(hit.name));
    const earlierCust = window.slice(i + 1).find((row) => {
      if (!isCustomerRow(row)) return false;
      const cText = String(row.content ?? row.text ?? "").trim();
      return Boolean(cText && !/^https?:\/\/\S+$/i.test(cText));
    });
    if (!earlierCust) continue;
    const custText = String(earlierCust.content ?? earlierCust.text ?? "").trim();
    const custTokens = tokenize(custText);
    const sharesToken = custTokens.some((t) => hitTokens.has(t));
    const directReply = i + 1 < window.length && window[i + 1] === earlierCust;
    if (sharesToken || directReply) return hit;
  }
  return undefined;
}
