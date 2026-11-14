/**
 * Safe 24/7 Follow-Up Engine running natively inside velo-bridge-baileys.
 *
 * Anti-Ban & WhatsApp Protection:
 * - Runs ONLY during daytime business hours (9:00 AM - 8:00 PM Sri Lanka time).
 * - Only sends to customers who messaged within the last 72h (WhatsApp-safe window).
 * - Never messages customers who already ordered or received a reminder in the last 3 days.
 * - Prioritizes the best 30 highest-intent leads per day per business.
 * - Follow-up wait timing selectable: 4 hours, 6 hours, or 12 hours.
 * - Uses session.queueProactive() which spaces messages with 20s-60s randomized jitter,
 *   simulates human typing presence, and limits to max 15 messages/hour per number.
 */

import { getSupabase } from "../lib/supabase.js";
import { getSession } from "../lib/sessionManager.js";
import { AB } from "../lib/antiBan.js";
import { matchProductInText, findDiscussedProduct } from "../lib/productMatch.js";
import {
  deriveCustomerProductInterestFromThread,
  productKey,
  type PersistedProductInterest,
} from "../lib/productInterest.js";

export type FollowUpProduct = {
  id?: string | null;
  shop_id?: string | null;
  name: string;
  price?: number | null;
  price_variants?: { label: string; price: number }[] | null;
  description?: string | null;
  is_active?: boolean | null;
};

export type Topic = "price" | "photos" | "size" | "colour" | "delivery" | "availability" | "details";
export type FollowUpLanguage = "si" | "ta" | "singlish" | "en";

const GREETING_ONLY = /^(?:hi+|hey+|hello+|helloo+|yo|good\s*(?:morning|afternoon|evening|day)|hi there|hey there|assalamu\s*alaikum|salam|vanakkam|ayubowan|ආයුබෝවන්|හලෝ|வணக்கம்|ok(?:ay)?|thanks?|thank you|ow|ඔව්|hari|හරි)$/iu;

const INTEREST = new RegExp(
  "\\b(?:price|prices|cost|how much|kiyada|kiyadha|kiyd|mila|gana|ganan|rate|photos?|pics?|pictures?|images?|sizes?|colou?rs?|stock|available|availability|thiyan\\w*|tiyan\\w*|thiyenawa\\w*|details?|info|ingredients?|wistara\\w*|wisthara\\w*|visthara\\w*|mokakda|monawada|hodama|best|suit\\w*|recommend\\w*|deliver\\w*|cod|ewanna\\w*|pennanna|balanna|show|send|want|need|buy|ganna|ona|oni|order\\w*|evlo|evvalavu|irukka|venum)\\b|[?？]|මිල|ගාන|කීයද|තියෙනවද|තියනවද|ඇතුයිද|පෙන්නන්න|බලන්න|විස්තර|දැනගැනීමට|අවශ්‍යයි|හදන|සකස්|භාවිතා|ගුණ|ප්‍රතිඵල|ඕන|ඕනේ|ෆොටෝ|ඇණවුම්|விலை|எவ்வளவு|வேணும்|படம்",
  "iu",
);

const TOPIC_PATTERNS: Array<[Topic, RegExp]> = [
  ["price", /\b(?:price|prices|cost|how much|kiyada|kiyadha|kiyd|mila|gana|ganan|rate|evlo|evvalavu)\b|මිල|ගාන|කීයද|விலை|எவ்வளவு/iu],
  ["photos", /\b(?:photos?|pics?|pictures?|images?|pennanna|balanna|show)\b|ෆොටෝ|පෙන්නන්න|බලන්න|படம்/iu],
  ["size", /\b(?:sizes?|big|small|large|medium|fit)\b|ප්‍රමාණ|සයිස්/iu],
  ["colour", /\b(?:colou?rs?|shade)\b|පාට|වර්ණ|நிறம்/iu],
  ["delivery", /\b(?:deliver\w*|courier|shipping|cod)\b|ඩිලිවරි/iu],
  ["availability", /\b(?:stock|available|availability|thiyan\w*|tiyan\w*|thiyenawa\w*|irukka)\b|තියනවද|තියෙනවද|ඇතුයිද/iu],
  ["details", /\b(?:details?|info|ingredients?|material|fabric|suit\w*|hodama|best|recommend\w*|wistara\w*|wisthara\w*|visthara\w*|benefits?|how to use|sakas|hadana)\b|විස්තර|දැනගැනීමට|හදන|සකස්|භාවිතා|ගුණ|ප්‍රතිඵල/iu],
];

const STALE_WINDOW_MS = 72 * 3_600_000; // > 72h -> WhatsApp spam risk
const FOLLOWUP_COOLDOWN_MS = 3 * 24 * 3_600_000; // 3 days
const BUYING_TOPICS = new Set<Topic>(["price", "size", "colour", "delivery", "availability"]);
const ORDER_CREATED_MARKER = /^\[ORDER_CREATED\]/i;
const SYS_ORDERED = "sys-ordered";
const SYS_PRODUCT_ASKED = "sys-product-asked";

/** Build common WhatsApp / Sri Lankan stored phone variants for order matching. */
export function buildPhoneVariants(phone: string): string[] {
  const raw = String(phone || "").trim();
  const out = new Set<string>();
  if (raw) out.add(raw);
  const withoutJid = raw.replace(/@.*/g, "").trim();
  if (withoutJid) out.add(withoutJid);
  const digits = withoutJid.replace(/\D/g, "");
  if (digits) {
    out.add(digits);
    out.add(`+${digits}`);
    if (digits.startsWith("94") && digits.length === 11) {
      out.add(`0${digits.slice(2)}`);
    } else if (digits.startsWith("0") && digits.length === 10) {
      const intl = `94${digits.slice(1)}`;
      out.add(intl);
      out.add(`+${intl}`);
    }
  }
  return Array.from(out).filter(Boolean);
}

/** Ensure Ordered supersedes Product Asked inside comma-separated chat_label_ids. */
export function applyOrderedLabelString(rawLabels: string | null | undefined): string {
  const current = String(rawLabels || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const next = current.filter((id) => id !== SYS_PRODUCT_ASKED && id !== SYS_ORDERED);
  next.push(SYS_ORDERED);
  return next.join(",");
}

export type CronMessageRow = {
  id?: string | null;
  role: string;
  content: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};
export type CronOrderRow = { id?: string; status?: string | null; created_at?: string | null };

export type CandidateEvalResult =
  | {
      eligible: false;
      reason: "no_chat" | "stale" | "quiet" | "recent_followup" | "ordered" | "no_interest" | "declined";
      clearReminder: boolean;
      ensureOrderedLabel?: boolean;
    }
  | {
      eligible: true;
      matchedProduct: FollowUpProduct | null;
      topics: Topic[];
      language: FollowUpLanguage;
      isCheckoutStage: boolean;
      score: number;
      lastCustomerAt: number;
    };

/**
 * Pure follow-up eligibility evaluator shared by cron execution and tests.
 * Strictly blocks any customer with an active/recent order, declined offer,
 * or no new post-order product inquiry, and resolves product strictly from
 * verified CUSTOMER expressions.
 */
export function evaluateFollowUpCandidate(args: {
  msgsNewestFirst: CronMessageRow[];
  ordersNewestFirst: CronOrderRow[];
  products: FollowUpProduct[];
  quietWindowMs: number;
  reminderKind?: string | null;
  chatLabelIds?: string | null;
  shopId?: string | null;
  lastFollowupSentAt?: string | null;
  persistedInterests?: PersistedProductInterest[];
  now?: number;
}): CandidateEvalResult {
  const {
    msgsNewestFirst,
    ordersNewestFirst,
    products,
    quietWindowMs,
    reminderKind,
    chatLabelIds,
    shopId,
    lastFollowupSentAt,
    persistedInterests = [],
  } = args;
  const now = args.now ?? Date.now();
  const activeProducts = products.filter(
    (p) => Boolean(p?.name) && p.is_active !== false && (!shopId || !p.shop_id || p.shop_id === shopId),
  );
  if (!msgsNewestFirst.length) {
    return { eligible: false, reason: "no_chat", clearReminder: true };
  }

  let lastCustomerAt: number | null = null;
  let lastFollowUpAt: number | null =
    lastFollowupSentAt && Number.isFinite(Date.parse(lastFollowupSentAt)) ? Date.parse(lastFollowupSentAt) : null;
  let lastOrderMarkerAt: number | null = null;

  for (const m of msgsNewestFirst) {
    const at = Date.parse(m.created_at);
    if (!Number.isFinite(at)) continue;
    const isCustomer = m.role === "user";
    const content = String(m.content ?? "").trim();
    const isMetaReminder = Boolean(m.metadata && m.metadata.is_followup_reminder === true);

    if (!isCustomer && (isMetaReminder || /^\[(?:interest|checkout|custom) reminder\]/i.test(content))) {
      if (lastFollowUpAt === null || at > lastFollowUpAt) lastFollowUpAt = at;
    }
    if (!isCustomer && ORDER_CREATED_MARKER.test(content)) {
      if (lastOrderMarkerAt === null || at > lastOrderMarkerAt) lastOrderMarkerAt = at;
    }
    if (isCustomer && (lastCustomerAt === null || at > lastCustomerAt)) {
      lastCustomerAt = at;
    }
  }

  if (lastCustomerAt === null) {
    return { eligible: false, reason: "no_chat", clearReminder: true };
  }
  if (now - lastCustomerAt > STALE_WINDOW_MS) {
    return { eligible: false, reason: "stale", clearReminder: true };
  }
  if (now - lastCustomerAt < quietWindowMs) {
    return { eligible: false, reason: "quiet", clearReminder: false };
  }
  if (lastFollowUpAt !== null && lastCustomerAt <= lastFollowUpAt) {
    return { eligible: false, reason: "recent_followup", clearReminder: true };
  }

  // Filter to non-cancelled orders (Pending, Confirmed, Packed, Dispatched, Delivered, Completed, etc.)
  const nonCancelledOrders = ordersNewestFirst.filter(
    (o) => String(o.status ?? "").trim().toLowerCase() !== "cancelled"
  );
  const latestOrder = nonCancelledOrders[0];
  const latestOrderAt = latestOrder?.created_at && Number.isFinite(Date.parse(latestOrder.created_at))
    ? Date.parse(latestOrder.created_at)
    : null;

  // Never send a follow-up if the customer placed a non-cancelled order within the 3-day cooldown window
  if (latestOrder && (latestOrderAt === null || latestOrderAt >= now - FOLLOWUP_COOLDOWN_MS)) {
    return { eligible: false, reason: "ordered", clearReminder: true, ensureOrderedLabel: true };
  }

  const effectiveOrderAt = Math.max(lastOrderMarkerAt ?? 0, latestOrderAt ?? 0);
  if (effectiveOrderAt > 0 && lastCustomerAt <= effectiveOrderAt) {
    return { eligible: false, reason: "ordered", clearReminder: true, ensureOrderedLabel: true };
  }

  // Only inspect conversation messages occurring strictly AFTER any completed/confirmed order
  const activeMsgs = effectiveOrderAt > 0
    ? msgsNewestFirst.filter((m) => {
        const at = Date.parse(m.created_at);
        return Number.isFinite(at) && at > effectiveOrderAt;
      })
    : msgsNewestFirst;

  const activeCustomerTexts: string[] = [];
  for (const m of activeMsgs) {
    if (m.role !== "user") continue;
    const content = String(m.content ?? "").trim();
    if (content && !/^\[[A-Z_]+\]/.test(content)) activeCustomerTexts.push(content);
  }

  // If the customer already has an ordered label and no clear post-order product inquiry exists, skip safely
  const hasOrderedLabel = String(chatLabelIds || "")
    .split(",")
    .map((s) => s.trim())
    .includes(SYS_ORDERED);

  // If the customer already has a non-cancelled order in history, a generic "?" or "delivery?" post-order check-in
  // must NEVER re-trigger a product follow-up; require an explicit catalog product inquiry after the order.
  const showedInterest = effectiveOrderAt > 0
    ? (activeProducts.length > 0 && activeCustomerTexts.some((t) => Boolean(mentionsProduct(t, activeProducts))) && customerShowedProductInterest(activeCustomerTexts, activeProducts))
    : customerShowedProductInterest(activeCustomerTexts, activeProducts);
  if (!showedInterest) {
    const orderedReason = effectiveOrderAt > 0 || hasOrderedLabel;
    return {
      eligible: false,
      reason: orderedReason ? "ordered" : "no_interest",
      clearReminder: true,
      ensureOrderedLabel: Boolean(effectiveOrderAt > 0),
    };
  }

  const chronologicalMsgs = [...activeMsgs].reverse();
  const derived = deriveCustomerProductInterestFromThread(chronologicalMsgs, activeProducts);

  if (derived.status === "declined") {
    return { eligible: false, reason: "declined", clearReminder: true };
  }

  let matchedProduct: FollowUpProduct | null = derived.activeProduct;

  if (!matchedProduct && persistedInterests.length > 0) {
    const latestActive = persistedInterests.find((row) => row.status === "active");
    if (latestActive) {
      const matchFromCatalog =
        activeProducts.find((p) => p.id && p.id === latestActive.product_id) ??
        activeProducts.find((p) => p.name.toLowerCase() === latestActive.product_name.toLowerCase());
      if (
        matchFromCatalog &&
        !derived.declinedKeys.has(productKey(matchFromCatalog)) &&
        !derived.purchasedKeys.has(productKey(matchFromCatalog))
      ) {
        matchedProduct = matchFromCatalog;
      }
    }
  }

  if (!matchedProduct && !derived.isAmbiguous && activeProducts.length > 0) {
    const fallbackMatch = findDiscussedProduct(activeMsgs, activeProducts) ?? null;
    if (
      fallbackMatch &&
      !derived.declinedKeys.has(productKey(fallbackMatch)) &&
      !derived.purchasedKeys.has(productKey(fallbackMatch))
    ) {
      matchedProduct = fallbackMatch;
    }
  }

  if (effectiveOrderAt > 0 && !matchedProduct) {
    return {
      eligible: false,
      reason: "ordered",
      clearReminder: true,
      ensureOrderedLabel: true,
    };
  }

  const recentBotMsgs = activeMsgs.filter((m) => m.role === "model").slice(0, 4);
  const askedForAddress = recentBotMsgs.some((m) =>
    /\b(?:address|phone\s*numbers?|delivery\s*address|city|order\s*details|confirm)\b|ලිපිනය|දුරකථන|ඇණවුම\s*තහවුරු|නම,\s*සම්පූර්ණ/i.test(String(m.content ?? ""))
  );
  const recentCustMsgs = activeCustomerTexts.slice(0, 4);
  const customerAgreedToBuy = recentCustMsgs.some((m) =>
    /\b(?:ok|hari|address|danna|ewannam|order|oni|ona)\b|හරි|ඕන|ඕනේ|එවන්නම්|\d(?:\s+\d)+/i.test(m)
  );
  const isCheckoutStage = reminderKind === "checkout" || (askedForAddress && customerAgreedToBuy);

  const combinedTexts = activeCustomerTexts.join(" ");
  const topics = TOPIC_PATTERNS.filter(([, re]) => re.test(combinedTexts)).map(([t]) => t);
  const language = detectLanguage(activeCustomerTexts);
  const score = calculateLeadScore(topics, matchedProduct, activeCustomerTexts, lastCustomerAt, now);

  return {
    eligible: true,
    matchedProduct,
    topics,
    language,
    isCheckoutStage,
    score,
    lastCustomerAt,
  };
}

export function extractProductAliases(p: FollowUpProduct): string[] {
  const aliases: string[] = [p.name.trim().toLowerCase()];
  const desc = p.description || "";

  // 1. Bracketed expressions in description and name e.g. (කොහිල කැඳ), (කුරක්කන් කැඳ), (Ladies Panties V Cut), (සරම්)
  if (desc) {
    for (const m of desc.matchAll(/\(([^)]+)\)/g)) {
      const raw = m[1].trim();
      if (raw.length >= 2 && raw.length <= 50 && !/^(?:cod|easy method|traditional method|taste tips|waist|size|\d+)/i.test(raw)) {
        aliases.push(raw.toLowerCase());
      }
    }
  }

  for (const m of p.name.matchAll(/\(([^)]+)\)/g)) {
    const raw = m[1].trim();
    if (raw.length >= 2 && raw.length <= 50) {
      aliases.push(raw.toLowerCase());
    }
  }

  // 2. First line / title before newline or emojis, if short & clean
  if (desc) {
    const firstLine = desc.split("\n")[0].replace(/[🌿🔥⚡🍃💚✔️✅💵🥣\d–—\-\/]+/gu, " ").trim();
    if (firstLine.length >= 3 && firstLine.length <= 40 && !firstLine.includes(":") && !firstLine.includes("pack")) {
      aliases.push(firstLine.toLowerCase());
    }
  }

  return [...new Set(aliases.map((a) => a.toLowerCase().trim()).filter(Boolean))];
}

/** The product a piece of text is talking about, or null. Driven dynamically by the shop's catalog. */
export function mentionsProduct<T extends FollowUpProduct>(text: string, products: T[]): T | null {
  return matchProductInText(text, products) ?? null;
}

export function customerShowedProductInterest(customerTexts: string[], products: FollowUpProduct[] = []): boolean {
  const realTexts = customerTexts.filter((raw) => {
    const t = raw.trim().replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!.,]+$/u, "").trim();
    return t && !GREETING_ONLY.test(t) && t !== "[sent an attachment]";
  });
  if (realTexts.length >= 3) return true;
  return realTexts.some((t) => (products.length > 0 && Boolean(mentionsProduct(t, products))) || INTEREST.test(t));
}

export function detectLanguage(customerTexts: string[]): FollowUpLanguage {
  const blob = customerTexts.join(" ");
  if (/[\u0D80-\u0DFF]/.test(blob)) return "si";
  if (/[\u0B80-\u0BFF]/.test(blob)) return "ta";
  if (/\b(?:eka|ekak|kiyada|kiyala|ewanna\w*|thiyenawa|tiyenawa|mokakda|ona|oni|nane|nehe|mata|oya|karanna|ganna|danna|balanna|pennanna|mila|gana|ko)\b/i.test(blob)) return "singlish";
  return "en";
}

function priceLine(product: FollowUpProduct): string {
  const base = Number(product.price);
  if (Number.isFinite(base) && base > 0) return `Rs.${base.toLocaleString("en-US")}`;
  const v = Array.isArray(product.price_variants) ? product.price_variants.map((x) => Number(x.price)).filter((n) => n > 0) : [];
  if (v.length) {
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    return lo === hi ? `Rs.${lo.toLocaleString("en-US")}` : `Rs.${lo.toLocaleString("en-US")} - Rs.${hi.toLocaleString("en-US")}`;
  }
  return "";
}

export function displayName(product: FollowUpProduct): string {
  return product.name.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, "").replace(/\s{2,}/g, " ").trim();
}

export function templateFollowUp(
  product: FollowUpProduct | null | undefined,
  topics: Topic[],
  language: FollowUpLanguage,
  stage: "interest" | "checkout" = "interest"
): string {
  const name = product ? displayName(product) : "";
  const price = product ? priceLine(product) : "";

  // 1. Checkout Stage Reminder (address & phone number request to complete order)
  if (stage === "checkout") {
    if (language === "si") {
      if (name) {
        return `Hi! ඔයා ඇණවුම් කිරීමට තෝරාගත් ${name} එක එවන්න delivery address එකයි phone numbers 2කුයි එවන්න පුළුවන්ද? 😊 ඉක්මනින්ම pack කරලා delivery කරන්නම්!`;
      }
      return `Hi! ඔයා ඇණවුම් කිරීමට තෝරාගත් items එවන්න delivery address එකයි phone numbers 2කුයි එවන්න පුළුවන්ද? 😊 ඉක්මනින්ම delivery කරන්නම්!`;
    }
    if (language === "singlish") {
      if (name) {
        return `Hi! Oya order karanna thoragaththa ${name} eka deliver karanna address ekai phone numbers 2i ewanna puluwanda? 😊 Ikmanatama pack karala ewannam!`;
      }
      return `Hi! Oya order karanna thoragaththa items deliver karanna address ekai phone numbers 2i ewanna puluwanda? 😊 Ikmanatama ewannam!`;
    }
    if (language === "ta") {
      if (name) {
        return `Hi! நீங்கள் தெரிவுசெய்த ${name} ஐ அனுப்ப உங்கள் delivery address மற்றும் phone number ஐ அனுப்ப முடியுமா? 😊 விரைவில் அனுப்பிவைப்போம்!`;
      }
      return `Hi! உங்கள் ஆர்டரை அனுப்ப delivery address மற்றும் phone number ஐ அனுப்ப முடியுமா? 😊 விரைவில் அனுப்பிவைப்போம்!`;
    }
    if (name) {
      return `Hi! Could you please share your delivery address and phone number so we can dispatch your ${name}? 😊`;
    }
    return `Hi! Could you please share your delivery address and phone number so we can dispatch your order? 😊`;
  }

  // 2. Interest Stage Reminder (inquiring / browsing stage)
  const topic = (["price", "size", "colour", "photos", "availability", "delivery", "details"] as Topic[]).find((t) => topics.includes(t));

  if (language === "si") {
    if (name) {
      const tail =
        topic === "price" && price ? `මිල ${price} යි.` :
        topic === "photos" ? "ඕන නම් තව photos එවන්නම්." :
        topic === "size" ? "ඔයාගේ size එක කියන්නකො, help කරන්නම්." :
        topic === "colour" ? "කැමති color එක කියන්නකො." :
        topic === "delivery" ? "Delivery ගැන දැනගන්න ඕන නම් කියන්නකො." :
        "තව විස්තර හෝ ඇණවුම දෙන්න ඕන නම් කියන්නකො.";
      return `Hi! ඔයා බැලූ ${name} ගැන තාම කැමතිද? ${tail} 😊`;
    }
    return `Hi! ඔයා කලින් විමසපු විස්තර ගැන තාම කැමතිද? තව විස්තර දැනගන්න හෝ ඇණවුම දෙන්න ඕන නම් කියන්නකො 😊`;
  }

  if (language === "singlish") {
    if (name) {
      const tail =
        topic === "price" && price ? `Price eka ${price} yi.` :
        topic === "photos" ? "Ona nam thawa photos ewannam." :
        topic === "size" ? "Oyage size eka kiyanna, help karannam." :
        topic === "colour" ? "Kamathi colour eka kiyanna." :
        topic === "delivery" ? "Delivery gana ona nam kiyanna." :
        "Thawa wistara hari order eka danna ona nam kiyanna.";
      return `Hi! Oya balapu ${name} gana tama interest da? ${tail} 😊`;
    }
    return `Hi! Oya kalin ahapu wistara gana tama interest da? Thawa wistara ona nam hari order eka danna ona nam kiyanna 😊`;
  }

  if (language === "ta") {
    if (name) {
      return `Hi! நீங்கள் பார்த்த ${name} பற்றி இன்னும் ஆர்வம் இருக்கிறதா? ${topic === "price" && price ? `விலை ${price}. ` : ""}தேவைப்பட்டால் சொல்லுங்கள் 😊`;
    }
    return `Hi! நீங்கள் கேட்ட விபரங்கள் பற்றி இன்னும் ஆர்வம் உள்ளதா? மேலும் விபரங்கள் அல்லது ஆர்டர் செய்ய விரும்பினால் சொல்லுங்கள் 😊`;
  }

  if (name) {
    const tail =
      topic === "price" && price ? `It's ${price}.` :
      topic === "photos" ? "Happy to send more photos if you'd like." :
      topic === "size" ? "Tell me your size and I'll help you pick." :
      topic === "colour" ? "Let me know which colour you like." :
      topic === "delivery" ? "Happy to explain delivery if you need." :
      "Happy to share more details or help you place an order.";
    return `Hi! Still interested in the ${name} you asked about? ${tail} 😊`;
  }
  return `Hi! Just following up on what you asked about earlier. Let us know if you need any details or would like to place an order! 😊`;
}

function formatVerifiedPrice(product?: FollowUpProduct | null): string {
  if (!product) return "";
  if (product.price != null && Number(product.price) > 0) {
    return `Rs. ${Number(product.price).toLocaleString()}`;
  }
  const nums = (product.price_variants ?? [])
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? `Rs. ${min.toLocaleString()}` : `Rs. ${min.toLocaleString()} - Rs. ${max.toLocaleString()}`;
}

function fillCustomTemplate(template: string, product?: FollowUpProduct | null, customerName: string = ""): string {
  if (/{product_name}/i.test(template) && !product?.name) {
    return "";
  }
  const verifiedPrice = formatVerifiedPrice(product);
  if (/{price}/i.test(template) && !verifiedPrice) {
    return "";
  }
  return template
    .replace(/{product_name}/gi, product?.name || "")
    .replace(/{customer_name}/gi, customerName || "there")
    .replace(/{price}/gi, verifiedPrice)
    .replace(/\s+/g, " ")
    .trim();
}

/** Check if current time in Asia/Colombo is within daytime hours (9 AM - 8 PM). */
function isWithinActiveHours(): boolean {
  try {
    const colomboTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Colombo", hour12: false, hour: "numeric" });
    const hour = parseInt(colomboTimeStr, 10);
    return hour >= 9 && hour < 20;
  } catch {
    const utcHour = new Date().getUTCHours();
    return utcHour >= 4 && utcHour < 15;
  }
}

/** Calculate the start of today's 9:00 AM window in Asia/Colombo */
function getTodayWindowStart(): string {
  try {
    const colomboDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" });
    return new Date(`${colomboDate}T09:00:00+05:30`).toISOString();
  } catch {
    return new Date(Date.now() - 24 * 3_600_000).toISOString();
  }
}

/** Calculate lead quality score to prioritize the best leads */
export function calculateLeadScore(
  topics: Topic[],
  matchedProduct: FollowUpProduct | null,
  customerTexts: string[],
  lastCustomerAt: number | null,
  now: number,
): number {
  let score = 0;
  if (topics.some((t) => BUYING_TOPICS.has(t))) score += 4;
  else if (topics.length > 0) score += 2;

  if (matchedProduct) score += 3;

  const realCustMsgs = customerTexts.filter((t) => {
    const s = t.trim();
    return s && !GREETING_ONLY.test(s) && s !== "[sent an attachment]";
  }).length;

  if (realCustMsgs >= 4) score += 3;
  else if (realCustMsgs >= 2) score += 2;
  else score += 1;

  const hoursSinceCustomer = (now - (lastCustomerAt ?? 0)) / 3_600_000;
  if (hoursSinceCustomer <= 24) score += 2;
  else if (hoursSinceCustomer <= 48) score += 1;

  return score;
}

interface QualifiedCandidate {
  candidateId: string;
  phone: string;
  score: number;
  lastCustomerAt: number;
  messageText: string;
  kind: "checkout" | "interest" | "custom";
  source: "custom" | "template";
  productId: string | null;
  productName: string | null;
  reminderKind: string | null;
  chatLabelIds: string | null;
}

/**
 * Main cron function executed 24/7 on Zeabur/VPS.
 * Strictly limits to max 30 follow-up messages per day per business,
 * sending to the best-scoring leads first.
 */
export async function runFollowUpJob(): Promise<{ examined: number; queued: number; skipped: number }> {
  const sb = getSupabase();
  const now = Date.now();
  const nowIso = new Date().toISOString();

  // 1. Anti-Ban Daytime Check (Strict Protection)
  if (!isWithinActiveHours()) {
    console.log("[followup-cron] 🌙 Outside active messaging hours (9 AM - 8 PM Colombo). Skipping run for anti-ban safety.");
    return { examined: 0, queued: 0, skipped: 0 };
  }

  console.log("[followup-cron] 🚀 Starting 24/7 follow-up check...");

  // 2. Load active businesses connected via whatsapp_web
  const { data: businesses, error: bizErr } = await sb
    .from("businesses")
    .select("id, business_name, brand_voice, bot_enabled, connection_mode, followup_custom_enabled, followup_custom_template, followup_smart_enabled, followup_wait_hours, followup_max_per_day")
    .eq("bot_enabled", true)
    .eq("connection_mode", "whatsapp_web");

  if (bizErr || !businesses) {
    console.error("[followup-cron] Failed to fetch businesses:", bizErr);
    return { examined: 0, queued: 0, skipped: 0 };
  }

  let totalExamined = 0;
  let totalQueued = 0;
  let totalSkipped = 0;

  for (const biz of businesses) {
    const shopId = biz.id;
    const session = getSession(shopId);

    // Only process shops whose WhatsApp session is connected
    if (!session || session.getInfo().status !== "connected") {
      continue;
    }

    // 3. Daily Cap: strictly at most 30 messages per day per shop (resets at 9:00 AM today)
    const MAX_DAILY_FOLLOWUPS = 30;
    const windowStart = getTodayWindowStart();
    let sentToday = 0;
    try {
      const { data: recentMeta, error: metaErr } = await sb
        .from("messages")
        .select("id")
        .eq("shop_id", shopId)
        .eq("role", "model")
        .or("content.like.[% reminder]%,metadata->>is_followup_reminder.eq.true")
        .gte("created_at", windowStart)
        .limit(35);
      if (!metaErr && recentMeta) {
        sentToday = recentMeta.length;
      } else {
        const [{ data: recentLegacy }, { data: recentCust }] = await Promise.all([
          sb
            .from("messages")
            .select("id")
            .eq("shop_id", shopId)
            .eq("role", "model")
            .like("content", "[% reminder]%")
            .gte("created_at", windowStart)
            .limit(35),
          sb
            .from("customers")
            .select("id")
            .eq("shop_id", shopId)
            .eq("checkout_reminder_sent", true)
            .gte("checkout_reminder_at", windowStart)
            .limit(35),
        ]);
        sentToday = Math.max(recentLegacy?.length ?? 0, recentCust?.length ?? 0);
      }
    } catch {
      sentToday = 0;
    }

    const room = Math.max(0, MAX_DAILY_FOLLOWUPS - sentToday);

    if (room <= 0) {
      console.log(`[followup-cron] Shop "${biz.business_name}" reached daily follow-up limit (${sentToday}/${MAX_DAILY_FOLLOWUPS}).`);
      continue;
    }

    // Wait hours chosen by business: 4, 6, or 12 hours (defaults to 4)
    const waitHours = [4, 6, 12].includes(Number(biz.followup_wait_hours)) ? Number(biz.followup_wait_hours) : 4;
    const quietWindowMs = waitHours * 3_600_000;

    // 4. Fetch Products for catalog matching (strictly scoped to this shop & active)
    const { data: productsRaw } = await sb
      .from("products")
      .select("id, shop_id, name, price, price_variants, description, is_active")
      .eq("shop_id", shopId)
      .eq("is_active", true);
    const products: FollowUpProduct[] = ((productsRaw ?? []) as FollowUpProduct[]).filter(
      (p) => Boolean(p.name) && p.is_active !== false && (!p.shop_id || p.shop_id === shopId),
    );

    // Optional pre-load of persisted customer product interests (fails open before SQL migration)
    const persistedByPhone = new Map<string, PersistedProductInterest[]>();
    try {
      const { data: interestsRaw, error: intErr } = await sb
        .from("customer_product_interests")
        .select("id, shop_id, customer_id, phone_number, product_id, product_name, variant_label, quantity, last_customer_interest_at, source_customer_message_id, status, checkout_context, followup_sent_at")
        .eq("shop_id", shopId)
        .order("last_customer_interest_at", { ascending: false })
        .limit(200);
      if (!intErr && interestsRaw) {
        for (const row of interestsRaw as PersistedProductInterest[]) {
          const list = persistedByPhone.get(row.phone_number) ?? [];
          list.push(row);
          persistedByPhone.set(row.phone_number, list);
        }
      }
    } catch {
      // safe pre-migration fallback
    }

    // 5. Fetch Candidates Due for this shop (fetch up to 60 to evaluate and pick the best)
    const { data: candidates, error: cErr } = await sb
      .from("customers")
      .select("id, phone_number, checkout_reminder_at, reminder_kind, chat_label_ids")
      .eq("shop_id", shopId)
      .eq("bot_active", true)
      .or("checkout_reminder_sent.eq.false,checkout_reminder_sent.is.null")
      .not("checkout_reminder_at", "is", null)
      .lte("checkout_reminder_at", nowIso)
      .order("checkout_reminder_at", { ascending: false })
      .limit(60);

    if (cErr || !candidates?.length) {
      continue;
    }

    totalExamined += candidates.length;
    const qualified: QualifiedCandidate[] = [];

    const loadCandidateMsgs = async (phoneVariants: string[]): Promise<CronMessageRow[]> => {
      const { data, error } = await sb
        .from("messages")
        .select("id, role, content, created_at, metadata")
        .eq("shop_id", shopId)
        .in("phone_number", phoneVariants)
        .order("created_at", { ascending: false })
        .limit(40);
      if (!error && data) return data as CronMessageRow[];
      const { data: fallback } = await sb
        .from("messages")
        .select("role, content, created_at")
        .eq("shop_id", shopId)
        .in("phone_number", phoneVariants)
        .order("created_at", { ascending: false })
        .limit(40);
      return (fallback ?? []) as CronMessageRow[];
    };

    const gatherPersisted = (phoneVariants: string[]): PersistedProductInterest[] => {
      const items: PersistedProductInterest[] = [];
      for (const pv of phoneVariants) {
        const hit = persistedByPhone.get(pv);
        if (hit) items.push(...hit);
      }
      return items.sort(
        (a, b) => Date.parse(b.last_customer_interest_at) - Date.parse(a.last_customer_interest_at),
      );
    };

    const buildLeadMessage = (evalResult: Extract<CandidateEvalResult, { eligible: true }>) => {
      const { matchedProduct, topics, language, isCheckoutStage } = evalResult;
      if (biz.followup_custom_enabled && biz.followup_custom_template) {
        const customText = fillCustomTemplate(biz.followup_custom_template, matchedProduct);
        return {
          messageText: customText,
          kind: "custom" as const,
          source: "custom" as const,
        };
      }
      const messageText = templateFollowUp(
        matchedProduct,
        topics,
        language,
        isCheckoutStage ? "checkout" : "interest",
      );
      return {
        messageText,
        kind: (isCheckoutStage ? "checkout" : "interest") as "checkout" | "interest",
        source: "template" as const,
      };
    };

    for (const c of candidates) {
      try {
        const phone = c.phone_number;
        const phoneVariants = buildPhoneVariants(phone);

        const [rawMsgs, { data: recentOrdersRaw }] = await Promise.all([
          loadCandidateMsgs(phoneVariants),
          sb
            .from("orders")
            .select("id, status, created_at")
            .eq("shop_id", shopId)
            .in("customer_phone", phoneVariants)
            .order("created_at", { ascending: false })
            .limit(10),
        ]);

        const evaluation = evaluateFollowUpCandidate({
          msgsNewestFirst: rawMsgs,
          ordersNewestFirst: (recentOrdersRaw ?? []) as CronOrderRow[],
          products,
          quietWindowMs,
          reminderKind: c.reminder_kind,
          chatLabelIds: (c as { chat_label_ids?: string | null }).chat_label_ids ?? null,
          shopId,
          persistedInterests: gatherPersisted(phoneVariants),
          now,
        });

        if (!evaluation.eligible) {
          if (evaluation.clearReminder) {
            const patch: Record<string, unknown> = {
              checkout_reminder_sent: true,
              checkout_reminder_at: null,
              reminder_kind: null,
            };
            if (evaluation.ensureOrderedLabel) {
              patch.chat_label_ids = applyOrderedLabelString(
                (c as { chat_label_ids?: string | null }).chat_label_ids
              );
            }
            await sb.from("customers").update(patch).eq("id", c.id);
            totalSkipped++;
          }
          continue;
        }

        const built = buildLeadMessage(evaluation);
        if (!built.messageText.trim()) {
          continue;
        }

        qualified.push({
          candidateId: c.id,
          phone,
          score: evaluation.score,
          lastCustomerAt: evaluation.lastCustomerAt,
          messageText: built.messageText,
          kind: built.kind,
          source: built.source,
          productId: evaluation.matchedProduct?.id ?? null,
          productName: evaluation.matchedProduct?.name ?? null,
          reminderKind: c.reminder_kind ?? null,
          chatLabelIds: (c as { chat_label_ids?: string | null }).chat_label_ids ?? null,
        });
      } catch (err: unknown) {
        console.warn(`[followup-cron] Failed to evaluate customer ${c.id}:`, (err as Error)?.message || err);
      }
    }

    // Sort qualified leads: highest intent score first, then most recent interaction
    qualified.sort((a, b) => b.score - a.score || b.lastCustomerAt - a.lastCustomerAt);

    // Pick the best leads up to room and single-run batch limit (max 10 per run to pace safely)
    const batchLimit = Math.min(room, 10);
    const toSend = qualified.slice(0, batchLimit);

    for (const lead of toSend) {
      try {
        const phoneVariants = buildPhoneVariants(lead.phone);

        // Live pre-send revalidation before queuing
        const [freshMsgs, { data: freshOrders }, { data: freshCust }] = await Promise.all([
          loadCandidateMsgs(phoneVariants),
          sb
            .from("orders")
            .select("id, status, created_at")
            .eq("shop_id", shopId)
            .in("customer_phone", phoneVariants)
            .order("created_at", { ascending: false })
            .limit(10),
          sb
            .from("customers")
            .select("checkout_reminder_sent, chat_label_ids")
            .eq("id", lead.candidateId)
            .maybeSingle(),
        ]);

        if (!freshCust || freshCust.checkout_reminder_sent === true) {
          continue;
        }

        const freshEval = evaluateFollowUpCandidate({
          msgsNewestFirst: freshMsgs,
          ordersNewestFirst: (freshOrders ?? []) as CronOrderRow[],
          products,
          quietWindowMs,
          reminderKind: lead.reminderKind,
          chatLabelIds: (freshCust as { chat_label_ids?: string | null }).chat_label_ids ?? lead.chatLabelIds,
          shopId,
          persistedInterests: gatherPersisted(phoneVariants),
          now: Date.now(),
        });

        if (!freshEval.eligible) {
          if (freshEval.clearReminder) {
            const patch: Record<string, unknown> = {
              checkout_reminder_sent: true,
              checkout_reminder_at: null,
              reminder_kind: null,
            };
            if (freshEval.ensureOrderedLabel) {
              patch.chat_label_ids = applyOrderedLabelString(
                (freshCust as { chat_label_ids?: string | null }).chat_label_ids ?? lead.chatLabelIds,
              );
            }
            await sb.from("customers").update(patch).eq("id", lead.candidateId);
            totalSkipped++;
          }
          continue;
        }

        let finalText = lead.messageText;
        let finalProductId = lead.productId;
        let finalProductName = lead.productName;
        let finalKind = lead.kind;
        let finalSource = lead.source;

        if ((freshEval.matchedProduct?.name ?? null) !== lead.productName || (freshEval.matchedProduct?.id ?? null) !== lead.productId) {
          const rebuilt = buildLeadMessage(freshEval);
          if (!rebuilt.messageText.trim()) continue;
          finalText = rebuilt.messageText;
          finalProductId = freshEval.matchedProduct?.id ?? null;
          finalProductName = freshEval.matchedProduct?.name ?? null;
          finalKind = rebuilt.kind;
          finalSource = rebuilt.source;
        }

        // Atomic conditional claim so concurrent cron runners cannot double-send
        const { data: claimed } = await sb
          .from("customers")
          .update({ checkout_reminder_sent: true })
          .eq("id", lead.candidateId)
          .or("checkout_reminder_sent.eq.false,checkout_reminder_sent.is.null")
          .select("id")
          .maybeSingle();

        if (!claimed?.id) {
          continue;
        }

        try {
          // Queue directly into Baileys session's anti-ban proactive queue
          // (automatically paces with 20s-60s jitter and simulates human typing)
          await session.queueProactive(lead.phone, finalText);
        } catch (queueErr) {
          await sb.from("customers").update({ checkout_reminder_sent: false }).eq("id", lead.candidateId);
          throw queueErr;
        }

        // Record in messages table WITHOUT exposing internal [interest reminder] marker
        const metadata = {
          is_followup_reminder: true,
          reminder_kind: finalKind,
          source: finalSource,
          product_id: finalProductId,
          product_name: finalProductName,
        };
        const { error: msgErr } = await sb.from("messages").insert({
          shop_id: shopId,
          phone_number: lead.phone,
          role: "model",
          content: finalText,
          metadata,
        });
        if (msgErr && /metadata|PGRST204|42703/i.test(msgErr.message)) {
          await sb.from("messages").insert({
            shop_id: shopId,
            phone_number: lead.phone,
            role: "model",
            content: finalText,
          });
        }

        try {
          await sb
            .from("customers")
            .update({ last_followup_sent_at: new Date().toISOString() })
            .eq("id", lead.candidateId);
        } catch {
          // safe pre-migration fallback
        }

        totalQueued++;
        console.log(`[followup-cron] ✅ Queued best lead (score ${lead.score}) for ${biz.business_name} -> ${lead.phone}`);
      } catch (err: unknown) {
        console.warn(`[followup-cron] Failed to queue lead ${lead.candidateId}:`, (err as Error)?.message || err);
      }
    }
  }

  console.log(`[followup-cron] ✨ Finished run: ${totalExamined} examined, ${totalQueued} queued safely, ${totalSkipped} skipped.`);
  return { examined: totalExamined, queued: totalQueued, skipped: totalSkipped };
}
