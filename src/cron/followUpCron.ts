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

export type FollowUpProduct = {
  name: string;
  price?: number | null;
  price_variants?: { label: string; price: number }[] | null;
  description?: string | null;
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

const NAME_STOP = new Set(["the", "and", "for", "with", "new", "powder", "bags", "bag", "instant", "natural", "products", "item", "pack"]);
const STALE_WINDOW_MS = 72 * 3_600_000; // > 72h -> WhatsApp spam risk
const FOLLOWUP_COOLDOWN_MS = 3 * 24 * 3_600_000; // 3 days
const BUYING_TOPICS = new Set<Topic>(["price", "size", "colour", "delivery", "availability"]);

export function extractProductAliases(p: FollowUpProduct): string[] {
  const aliases: string[] = [p.name.trim().toLowerCase()];
  const desc = p.description || "";
  if (desc) {
    for (const m of desc.matchAll(/\(([^)]+)\)/g)) {
      const raw = m[1].trim();
      if (raw.length >= 2 && raw.length <= 50 && !/^(?:cod|easy method|traditional method|taste tips|\d+)/i.test(raw)) {
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
  return [...new Set(aliases)];
}

export function mentionsProduct<T extends FollowUpProduct>(text: string, products: T[]): T | null {
  const hay = text.toLowerCase();
  if (!hay.trim() || !products.length) return null;
  for (const product of products) {
    const fullName = product.name.trim().toLowerCase();
    if (fullName && hay.includes(fullName)) return product;
    const aliases = extractProductAliases(product);
    for (const alias of aliases) {
      if (alias.length >= 3 && hay.includes(alias)) return product;
    }
    const allTokens = aliases.flatMap((a) => (a.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3 && !NAME_STOP.has(t)));
    const hits = allTokens.filter((t) => hay.includes(t) || (t.length > 4 && t.endsWith("s") && hay.includes(t.slice(0, -1)))).length;
    if (hits >= 1) return product;
  }
  return null;
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

export function templateFollowUp(product: FollowUpProduct | null | undefined, topics: Topic[], language: FollowUpLanguage): string {
  const name = product ? displayName(product) : "";
  const price = product ? priceLine(product) : "";
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

function fillCustomTemplate(template: string, product?: FollowUpProduct | null, customerName: string = ""): string {
  return template
    .replace(/{product_name}/g, product?.name || "our product")
    .replace(/{customer_name}/g, customerName || "there")
    .replace(/{price}/g, product?.price ? `Rs. ${product.price.toLocaleString()}` : "");
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
  prefix: string;
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
    const { data: recentSent } = await sb
      .from("messages")
      .select("id")
      .eq("shop_id", shopId)
      .eq("role", "model")
      .like("content", "[% reminder]%")
      .gte("created_at", windowStart)
      .limit(35);

    const sentToday = recentSent?.length ?? 0;
    const room = Math.max(0, MAX_DAILY_FOLLOWUPS - sentToday);

    if (room <= 0) {
      console.log(`[followup-cron] Shop "${biz.business_name}" reached daily follow-up limit (${sentToday}/${MAX_DAILY_FOLLOWUPS}).`);
      continue;
    }

    // Wait hours chosen by business: 4, 6, or 12 hours (defaults to 4)
    const waitHours = [4, 6, 12].includes(Number(biz.followup_wait_hours)) ? Number(biz.followup_wait_hours) : 4;
    const quietWindowMs = waitHours * 3_600_000;

    // 4. Fetch Products for catalog matching
    const { data: productsRaw } = await sb
      .from("products")
      .select("name, price, price_variants, description")
      .eq("shop_id", shopId)
      .eq("is_active", true);
    const products: FollowUpProduct[] = (productsRaw ?? []).filter((p) => p.name);

    // 5. Fetch Candidates Due for this shop (fetch up to 60 to evaluate and pick the best)
    const { data: candidates, error: cErr } = await sb
      .from("customers")
      .select("id, phone_number, checkout_reminder_at, reminder_kind")
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

    for (const c of candidates) {
      try {
        const phone = c.phone_number;

        // Fetch recent chat messages for this customer
        const { data: rawMsgs } = await sb
          .from("messages")
          .select("role, content, created_at")
          .eq("shop_id", shopId)
          .eq("phone_number", phone)
          .order("created_at", { ascending: false })
          .limit(30);

        const msgs = rawMsgs || [];
        if (!msgs.length) {
          await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", c.id);
          totalSkipped++;
          continue;
        }

        // Parse timestamps
        let lastCustomerAt: number | null = null;
        let lastBotAt: number | null = null;
        let lastFollowUpAt: number | null = null;
        const customerTexts: string[] = [];

        for (const m of msgs) {
          const at = Date.parse(m.created_at);
          const isCustomer = m.role === "user";
          const content = String(m.content ?? "").trim();

          if (!isCustomer && /^\[(?:interest|checkout|custom) reminder\]/i.test(content)) {
            if (lastFollowUpAt === null || at > lastFollowUpAt) lastFollowUpAt = at;
          }
          if (isCustomer) {
            if (lastCustomerAt === null || at > lastCustomerAt) lastCustomerAt = at;
            if (!/^\[[A-Z_]+\]/.test(content)) customerTexts.push(content);
          } else {
            if (lastBotAt === null || at > lastBotAt) lastBotAt = at;
          }
        }

        // Check Stale (>72h): outside safe WhatsApp window
        if (lastCustomerAt && now - lastCustomerAt > STALE_WINDOW_MS) {
          await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", c.id);
          totalSkipped++;
          continue;
        }

        // Check Quiet Window (< waitHours e.g. 4h, 6h, 12h): customer still in silence window
        if (lastCustomerAt && now - lastCustomerAt < quietWindowMs) {
          // Leave eligible for subsequent run
          continue;
        }

        // Check recent follow-up cooldown
        if (lastFollowUpAt && lastCustomerAt && lastCustomerAt <= lastFollowUpAt) {
          await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", c.id);
          totalSkipped++;
          continue;
        }

        // Check if customer already placed an order in last 3 days
        const sinceOrder = new Date(now - FOLLOWUP_COOLDOWN_MS).toISOString();
        const { data: recentOrder } = await sb
          .from("orders")
          .select("id")
          .eq("shop_id", shopId)
          .eq("customer_phone", phone)
          .gte("created_at", sinceOrder)
          .limit(1)
          .maybeSingle();

        if (recentOrder) {
          await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", c.id);
          totalSkipped++;
          continue;
        }

        // Check Product Interest
        const showedInterest = customerShowedProductInterest(customerTexts, products);
        if (!showedInterest) {
          await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", c.id);
          totalSkipped++;
          continue;
        }

        // Match product discussed
        let matchedProduct: FollowUpProduct | null = null;
        for (const text of customerTexts) {
          matchedProduct = mentionsProduct(text, products);
          if (matchedProduct) break;
        }

        // Detect topic and language
        const combinedTexts = customerTexts.join(" ");
        const topics = TOPIC_PATTERNS.filter(([, re]) => re.test(combinedTexts)).map(([t]) => t);
        const language = detectLanguage(customerTexts);

        // Calculate lead quality score
        const score = calculateLeadScore(topics, matchedProduct, customerTexts, lastCustomerAt, now);

        // Formulate follow-up message text
        let messageText = "";
        let prefix = "[interest reminder]";

        if (biz.followup_custom_enabled && biz.followup_custom_template) {
          messageText = fillCustomTemplate(biz.followup_custom_template, matchedProduct);
          prefix = "[custom reminder]";
        } else {
          messageText = templateFollowUp(matchedProduct, topics, language);
        }

        if (!messageText.trim()) {
          continue;
        }

        qualified.push({
          candidateId: c.id,
          phone,
          score,
          lastCustomerAt: lastCustomerAt ?? 0,
          messageText,
          prefix,
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
        // Queue directly into Baileys session's anti-ban proactive queue
        // (automatically paces with 20s-60s jitter and simulates human typing)
        await session.queueProactive(lead.phone, lead.messageText);

        // Record in messages table
        await sb.from("messages").insert({
          shop_id: shopId,
          phone_number: lead.phone,
          role: "model",
          content: `${lead.prefix} ${lead.messageText}`,
        });

        // Mark sent
        await sb.from("customers").update({ checkout_reminder_sent: true }).eq("id", lead.candidateId);

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
