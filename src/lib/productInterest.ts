import { countNamedProducts, matchProductInText, type NamedProduct } from "./productMatch.js";

export type InterestStatus = "active" | "declined" | "purchased";

export interface TrackableProduct extends NamedProduct {
  id?: string | null;
  price?: number | null;
  price_variants?: { label: string; price: number }[] | null;
  description?: string | null;
  is_active?: boolean | null;
  shop_id?: string | null;
}

export interface PersistedProductInterest {
  id: string;
  shop_id: string;
  customer_id: string | null;
  phone_number: string;
  product_id: string;
  product_name: string;
  variant_label: string | null;
  quantity: number;
  last_customer_interest_at: string;
  source_customer_message_id: string | null;
  status: InterestStatus;
  checkout_context: Record<string, unknown> | null;
  followup_sent_at: string | null;
}

export interface ThreadMessageInput {
  id?: string | null;
  role?: string;
  from?: string;
  content?: string | null;
  text?: string | null;
  created_at?: string;
  at?: number;
  metadata?: Record<string, unknown> | null;
}

export interface DerivedInterestState<T extends TrackableProduct> {
  activeProduct: T | null;
  status: "active" | "declined" | "purchased" | "none";
  discussedProducts: T[];
  declinedKeys: Set<string>;
  purchasedKeys: Set<string>;
  sourceMessageId: string | null;
  lastInterestAt: number | null;
  isAmbiguous: boolean;
}

const HARD_DECLINE =
  /\b(?:not\s*interested|no\s*thanks?|no\s*need|don'?t\s*(?:want|need)|never\s*mind|cancel\s*(?:it|this|that|my\s*order)?|too\s*(?:expensive|much|high)|leave\s*it|skip\s*it|pass)\b|එපා|ඕන\s*නෑ|ඕනෙ\s*නෑ|වැඩක්\s*නෑ|කැමති\s*නෑ|වැඩියි|വേண்டாம்|விருப்பம்\s*இல்லை/iu;

const SOFT_NEGATIVE =
  /^(?:no+(?:\s+no+)*|nope|nah|na|naha|nahe|ne|nehe|epa|epaa|venam|vendam|venda|illa|illai|නෑ|නැහැ|එපා)[!.,\s]*$/iu;

const CONTEXTUAL_FOLLOWUP_QUESTION =
  /\b(?:price|prices|cost|how\s*much|kiyada|kiyadha|kiyd|mila|gana|ganan|rate|cod|cash\s*on\s*deliv\w*|deliv\w*|courier|shipping|availab\w*|in\s*stock|stock|thiyan\w*|tiyan\w*|thiyen\w*|sizes?|colou?rs?|photos?|pics?|pictures?|details?|info|wistara\w*|wisthara\w*|evlo|evvalavu|irukka)\b|[?？]|මිල|ගාන|කීයද|තියෙනවද|තියනවද|ඩිලිවරි|ෆොටෝ|விலை|எவ்வளவு/iu;

const BOT_PROMO_OR_ALT =
  /\b(?:instead|other\s*items|also\s*(?:have|recommend|available)|might\s*like|recommend(?:ed)?\s*for\s*you|another\s*item)\b|වෙනත්\s*items|වෙන\s*(?:items?|ඒවා)/i;

const ORDER_CREATED_MARKER = /^\[ORDER_CREATED\]/i;
const REMINDER_PREFIX = /^\[(?:interest|checkout|custom)\s+reminder\]/i;

function isCustomerEntry(m: ThreadMessageInput): boolean {
  if (m.role) return m.role === "user";
  if (m.from) return m.from === "customer";
  return false;
}

function getEntryText(m: ThreadMessageInput): string {
  return String(m.content ?? m.text ?? "").trim();
}

function getEntryTime(m: ThreadMessageInput): number {
  if (typeof m.at === "number" && Number.isFinite(m.at)) return m.at;
  if (m.created_at) {
    const parsed = Date.parse(m.created_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function productKey(p: Pick<TrackableProduct, "id" | "name">): string {
  return p.id ? `id:${p.id}` : `name:${p.name.trim().toLowerCase()}`;
}

export function isExplicitCustomerDecline(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  return HARD_DECLINE.test(cleaned) || SOFT_NEGATIVE.test(cleaned);
}

export function isHardDeclineOnly(text: string): boolean {
  return HARD_DECLINE.test(text.trim());
}

export function isContextualFollowUpQuestion(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || isExplicitCustomerDecline(cleaned)) return false;
  return CONTEXTUAL_FOLLOWUP_QUESTION.test(cleaned);
}

export function extractQuotedReplyProduct<T extends TrackableProduct>(
  text: string,
  products: T[],
): T | undefined {
  if (!text || !products.length) return undefined;
  const quoted = text.match(/\[Replying\s+to:\s*([^\]]+)\]/i);
  if (!quoted?.[1]) return undefined;
  return matchProductInText(quoted[1], products);
}

export function deriveCustomerProductInterestFromThread<T extends TrackableProduct>(
  msgsChronologicalOldestFirst: ThreadMessageInput[],
  products: T[],
): DerivedInterestState<T> {
  const declinedKeys = new Set<string>();
  const purchasedKeys = new Set<string>();
  const discussedQueue: T[] = [];
  let activeProduct: T | null = null;
  let softPausedProduct: T | null = null;
  let lastCustomerProductStatus: "active" | "declined" | "purchased" | "none" = "none";
  let sourceMessageId: string | null = null;
  let lastInterestAt: number | null = null;
  let lastCustomerInquiryText = "";
  let isAmbiguous = false;

  const pushDiscussed = (p: T) => {
    const k = productKey(p);
    const filtered = discussedQueue.filter((item) => productKey(item) !== k);
    filtered.unshift(p);
    discussedQueue.length = 0;
    discussedQueue.push(...filtered);
  };

  for (let i = 0; i < msgsChronologicalOldestFirst.length; i++) {
    const m = msgsChronologicalOldestFirst[i];
    const text = getEntryText(m);
    if (!text) continue;
    const at = getEntryTime(m) || i;

    if (!isCustomerEntry(m)) {
      if (m.metadata && m.metadata.is_followup_reminder === true) continue;
      if (REMINDER_PREFIX.test(text)) continue;

      if (ORDER_CREATED_MARKER.test(text)) {
        const orderedNames = text.replace(ORDER_CREATED_MARKER, "").trim();
        const orderedProd = matchProductInText(orderedNames, products);
        if (orderedProd) {
          purchasedKeys.add(productKey(orderedProd));
          if (activeProduct && productKey(activeProduct) === productKey(orderedProd)) {
            activeProduct = null;
            lastCustomerProductStatus = "purchased";
          }
        } else if (activeProduct) {
          purchasedKeys.add(productKey(activeProduct));
          activeProduct = null;
          lastCustomerProductStatus = "purchased";
        }
        softPausedProduct = null;
        continue;
      }

      if (
        !activeProduct &&
        !softPausedProduct &&
        lastCustomerInquiryText &&
        !BOT_PROMO_OR_ALT.test(text) &&
        !/^https?:\/\/\S+$/i.test(text) &&
        countNamedProducts(text, products) === 1
      ) {
        const botHit = matchProductInText(text, products);
        if (botHit && !declinedKeys.has(productKey(botHit))) {
          const hitLower = botHit.name.toLowerCase();
          const custWords = lastCustomerInquiryText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
          const overlaps = custWords.some((w) => hitLower.includes(w) || (w.endsWith("ies") && hitLower.includes(w.slice(0, -3) + "y")));
          if (overlaps) {
            activeProduct = botHit;
            lastCustomerProductStatus = "active";
            lastInterestAt = at;
            isAmbiguous = false;
            pushDiscussed(botHit);
          }
        }
      }
      continue;
    }

    if (/^https?:\/\/\S+$|^wa-media:\S+$/i.test(text)) {
      continue;
    }

    const quotedProduct = extractQuotedReplyProduct(text, products);
    const namedCount = countNamedProducts(text, products);
    const directProduct = quotedProduct ?? (namedCount < 3 ? matchProductInText(text, products) : undefined);

    if (directProduct) {
      const k = productKey(directProduct);
      if (isHardDeclineOnly(text)) {
        declinedKeys.add(k);
        if (activeProduct && productKey(activeProduct) === k) {
          activeProduct = null;
          lastCustomerProductStatus = "declined";
        }
        continue;
      }
      declinedKeys.delete(k);
      purchasedKeys.delete(k);
      activeProduct = directProduct;
      softPausedProduct = null;
      lastCustomerProductStatus = "active";
      sourceMessageId = m.id ? String(m.id) : null;
      lastInterestAt = at;
      isAmbiguous = false;
      pushDiscussed(directProduct);
      lastCustomerInquiryText = "";
      continue;
    }

    if (namedCount >= 2) {
      lastCustomerInquiryText = text;
      continue;
    }

    if (isExplicitCustomerDecline(text)) {
      if (isHardDeclineOnly(text)) {
        if (activeProduct) {
          declinedKeys.add(productKey(activeProduct));
          activeProduct = null;
        }
        softPausedProduct = null;
        lastCustomerProductStatus = "declined";
      } else {
        if (activeProduct) {
          softPausedProduct = activeProduct;
          declinedKeys.add(productKey(activeProduct));
          activeProduct = null;
        }
        lastCustomerProductStatus = "declined";
      }
      continue;
    }

    if (isContextualFollowUpQuestion(text)) {
      if (activeProduct) {
        lastInterestAt = at;
        lastCustomerProductStatus = "active";
      } else if (softPausedProduct) {
        activeProduct = softPausedProduct;
        declinedKeys.delete(productKey(softPausedProduct));
        softPausedProduct = null;
        lastCustomerProductStatus = "active";
        lastInterestAt = at;
      } else {
        lastCustomerInquiryText = text;
        if (!lastCustomerInquiryText) isAmbiguous = true;
      }
      continue;
    }

    lastCustomerInquiryText = text;
  }

  return {
    activeProduct,
    status: activeProduct ? "active" : lastCustomerProductStatus,
    discussedProducts: discussedQueue.filter((p) => !declinedKeys.has(productKey(p)) && !purchasedKeys.has(productKey(p))),
    declinedKeys,
    purchasedKeys,
    sourceMessageId,
    lastInterestAt,
    isAmbiguous,
  };
}

