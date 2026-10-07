/**
 * Anti-ban safeguards for the (unofficial) Baileys WhatsApp client.
 *
 * Nothing here can GUARANTEE a number is never restricted — WhatsApp does not
 * publish its rules and unofficial clients are against its terms. These
 * safeguards remove the behaviours that most reliably get numbers flagged:
 *
 *  - bursts / machine-regular timing            -> paced sends, jittered gaps
 *  - runaway loops (bot <-> auto-responder)     -> per-recipient + global caps
 *  - cold / unsolicited messages                -> proactive sends ONLY to people
 *                                                  who messaged us recently
 *  - new numbers blasting messages              -> warm-up tiers by number age
 *  - messaging people who asked us to stop      -> opt-out honoured
 *  - messaging at odd hours                     -> proactive sends limited to a window
 *  - hammering WhatsApp after errors            -> circuit breaker
 *
 * Every limit is an env var so it can be tuned without a code change, and
 * ANTI_BAN_ENABLED=false switches the whole module off in an emergency.
 */
import * as fs from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function parseHours(raw: string | undefined, defStart: number, defEnd: number): [number, number] {
  const m = String(raw || "").match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return [defStart, defEnd];
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= 0 && a <= 23 && b >= 1 && b <= 24 && a < b ? [a, b] : [defStart, defEnd];
}

const [HOURS_START, HOURS_END] = parseHours(process.env.AB_PROACTIVE_HOURS, 9, 20);

export const AB = {
  enabled: envBool("ANTI_BAN_ENABLED", true),
  /** Mark the customer's message as read right before the bot answers, like a person would. */
  markRead: envBool("AB_MARK_READ", true),

  // Any outbound message (replies, dashboard sends, proactive): pacing + caps.
  minGapMs: envNum("AB_MIN_GAP_MS", 1200),
  gapJitterMs: envNum("AB_GAP_JITTER_MS", 1800),
  perMinute: envNum("AB_SEND_PER_MIN", 25),
  perHour: envNum("AB_SEND_PER_HOUR", 300),
  perDay: envNum("AB_SEND_PER_DAY", 1500),
  perRecipientPerMin: envNum("AB_RECIPIENT_PER_MIN", 10),
  perRecipientPerHour: envNum("AB_RECIPIENT_PER_HOUR", 40),

  // Circuit breaker.
  breakerFailures: envNum("AB_BREAKER_FAILURES", 6),
  breakerCooldownMs: envNum("AB_BREAKER_COOLDOWN_MS", 15 * 60_000),
  overlimitCooldownMs: envNum("AB_OVERLIMIT_COOLDOWN_MS", 30 * 60_000),

  // Proactive (unsolicited-style) sends such as follow-up reminders.
  proactiveGapMinMs: envNum("AB_PROACTIVE_GAP_MIN_MS", 20_000),
  proactiveGapMaxMs: envNum("AB_PROACTIVE_GAP_MAX_MS", 60_000),
  proactivePerHour: envNum("AB_PROACTIVE_PER_HOUR", 15),
  /** Ceiling for the mature-number daily tier. Younger numbers get less (see proactiveTierForAgeDays). */
  proactiveMaxPerDay: envNum("AB_PROACTIVE_MAX_PER_DAY", 100),
  /** Only message people who wrote to us within this many hours. */
  proactiveMaxInboundAgeMs: envNum("AB_PROACTIVE_MAX_INBOUND_AGE_H", 72) * 3_600_000,
  proactiveQueueMax: envNum("AB_PROACTIVE_QUEUE_MAX", 200),
  hoursStart: HOURS_START,
  hoursEnd: HOURS_END,
  tz: process.env.AB_TZ?.trim() || "Asia/Colombo",
} as const;

/** Proactive messages/day allowed by how long the number has been paired. */
export function proactiveTierForAgeDays(ageDays: number): number {
  let tier: number;
  if (ageDays < 1) tier = 0;
  else if (ageDays < 3) tier = 5;
  else if (ageDays < 7) tier = 15;
  else if (ageDays < 14) tier = 30;
  else if (ageDays < 30) tier = 60;
  else tier = AB.proactiveMaxPerDay;
  return Math.min(tier, AB.proactiveMaxPerDay);
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type BlockCode =
  | "rate_limit"
  | "recipient_limit"
  | "busy"
  | "breaker"
  | "opted_out"
  | "no_recent_inbound"
  | "duplicate"
  | "warmup"
  | "quota"
  | "queue_full"
  | "outside_hours";

/** Thrown when a send is refused on purpose (not a WhatsApp/network failure). */
export class SendBlockedError extends Error {
  constructor(
    public readonly code: BlockCode,
    message: string,
    /** When a retry could succeed, roughly how long to wait. */
    public readonly retryAfterMs?: number,
    /** true = retrying will never help (e.g. the customer opted out). */
    public readonly permanent = false,
  ) {
    super(message);
    this.name = "SendBlockedError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function localParts(ts: number, tz: string): { day: string; hour: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ts))) parts[p.type] = p.value;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    const d = new Date(ts);
    return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  }
}

/** Errors that mean "the socket is down", not "WhatsApp is unhappy with us". */
const CONNECTIVITY_ERROR = /connection (closed|lost|terminated)|not connected|socket|stream|econn|enotfound|etimedout|timed? ?out|network|session not connected|aborted/i;
/** Errors that mean WhatsApp is telling us to slow down. */
const OVERLIMIT_ERROR = /rate-?overlimit|too many requests|\b429\b/i;

const OPT_OUT_RE = /^(stop|unsubscribe|opt[\s-]?out|stop (messages?|messaging|texting)|no more messages?|නවත්වන්න)[.!\s]*$/i;
const OPT_IN_RE = /^(start|subscribe|opt[\s-]?in)[.!\s]*$/i;

const STATE_MAX_INBOUND = 5000;

interface GuardState {
  pairedAt?: number;
  inbound: Record<string, number>;
  optOut: string[];
  proactiveDay?: { day: string; count: number };
  proactiveSent: Record<string, number>;
}

// ─── The guard ───────────────────────────────────────────────────────────────

export class SendGuard {
  private state: GuardState = { inbound: {}, optOut: [], proactiveSent: {} };
  private optOut = new Set<string>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Sliding windows (ms timestamps, ascending).
  private sent: number[] = [];
  private perRecipient = new Map<string, number[]>();
  private proactiveHour: number[] = [];
  private nextSlotAt = 0;

  // Circuit breaker.
  private breakerUntil = 0;
  private consecutiveFailures = 0;
  private lastBreakerReason = "";

  constructor(private readonly shopId: string, private readonly filePath: string) {}

  // ── persistence ──────────────────────────────────────────────────────────

  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<GuardState>;
      this.state = {
        pairedAt: typeof raw.pairedAt === "number" ? raw.pairedAt : undefined,
        inbound: raw.inbound && typeof raw.inbound === "object" ? raw.inbound : {},
        optOut: Array.isArray(raw.optOut) ? raw.optOut.map(String) : [],
        proactiveDay: raw.proactiveDay,
        proactiveSent: raw.proactiveSent && typeof raw.proactiveSent === "object" ? raw.proactiveSent : {},
      };
      this.optOut = new Set(this.state.optOut);
    } catch (e) {
      console.warn(`[antiban ${this.shopId}] could not load state (starting fresh):`, (e as Error)?.message || e);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 5000);
  }

  private serialise(): string {
    const now = Date.now();
    // Bound the file: forget people we have not heard from in 60 days, cap the rest.
    const entries = Object.entries(this.state.inbound).filter(([, ts]) => now - ts < 60 * DAY_MS);
    entries.sort((a, b) => b[1] - a[1]);
    this.state.inbound = Object.fromEntries(entries.slice(0, STATE_MAX_INBOUND));
    this.state.proactiveSent = Object.fromEntries(
      Object.entries(this.state.proactiveSent).filter(([, ts]) => now - ts < 7 * DAY_MS),
    );
    this.state.optOut = [...this.optOut];
    return JSON.stringify(this.state);
  }

  /** Write state to disk. Synchronous so it is safe to call during shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, this.serialise(), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.warn(`[antiban ${this.shopId}] could not save state:`, (e as Error)?.message || e);
    }
  }

  /** Drop pending writes (the auth folder is being wiped). */
  cancel(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = false;
  }

  // ── number age / warm-up ─────────────────────────────────────────────────

  /**
   * Stamp when this number was paired. A freshly scanned number starts its
   * warm-up now. A session that already existed before this feature shipped is
   * assumed to be 14 days old (middle tier): we cannot know its real age, and
   * guessing "brand new" would silently stop its reminders.
   */
  onConnectionOpen(freshlyPaired: boolean): void {
    this.consecutiveFailures = 0;
    if (this.state.pairedAt) return;
    this.state.pairedAt = freshlyPaired ? Date.now() : Date.now() - 14 * DAY_MS;
    this.markDirty();
  }

  private ageDays(now: number): number {
    const paired = this.state.pairedAt ?? now - 14 * DAY_MS;
    return Math.max(0, (now - paired) / DAY_MS);
  }

  // ── inbound tracking / opt-out ───────────────────────────────────────────

  noteInbound(phone: string, text: string): void {
    if (!phone) return;
    this.state.inbound[phone] = Date.now();
    const t = (text || "").trim();
    if (t && t.length <= 40) {
      if (OPT_OUT_RE.test(t)) {
        if (!this.optOut.has(phone)) console.log(`[antiban ${this.shopId}] ${phone} opted out of proactive messages`);
        this.optOut.add(phone);
      } else if (OPT_IN_RE.test(t)) {
        this.optOut.delete(phone);
      }
    }
    this.markDirty();
  }

  lastInboundAt(phone: string): number | null {
    return this.state.inbound[phone] ?? null;
  }

  /** Seed from the database when we have no local record (e.g. just after deploying this feature). */
  seedInbound(phone: string, ts: number): void {
    if (!phone || !Number.isFinite(ts)) return;
    if ((this.state.inbound[phone] ?? 0) >= ts) return;
    this.state.inbound[phone] = ts;
    this.markDirty();
  }

  isOptedOut(phone: string): boolean {
    return this.optOut.has(phone);
  }

  // ── circuit breaker ──────────────────────────────────────────────────────

  private trip(ms: number, why: string): void {
    this.breakerUntil = Date.now() + ms;
    this.consecutiveFailures = 0;
    this.lastBreakerReason = why.slice(0, 200);
    console.error(`[antiban ${this.shopId}] CIRCUIT BREAKER OPEN for ${Math.round(ms / MINUTE_MS)} min — ${this.lastBreakerReason}`);
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(err: unknown): void {
    if (!AB.enabled) return;
    const msg = String((err as { message?: string })?.message || err);
    if (OVERLIMIT_ERROR.test(msg)) {
      this.trip(AB.overlimitCooldownMs, msg);
      return;
    }
    // A dropped socket is handled by the reconnect logic; it is not a ban signal.
    if (CONNECTIVITY_ERROR.test(msg)) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= AB.breakerFailures) this.trip(AB.breakerCooldownMs, msg);
  }

  /**
   * Why a reply to `phone` would be refused right now (breaker open, or this
   * recipient is over its cap), or null if it could go out. Read-only — counts
   * nothing. Used to skip the AI call when the reply could not be sent anyway.
   */
  replyBlockedReason(phone: string): string | null {
    if (!AB.enabled) return null;
    const now = Date.now();
    if (now < this.breakerUntil) return "breaker open";
    const recent = this.perRecipient.get(phone.replace(/\D/g, "")) ?? [];
    const lastHour = SendGuard.countSince(recent, now - HOUR_MS).count;
    if (AB.perRecipientPerHour > 0 && lastHour >= AB.perRecipientPerHour) return "recipient hourly cap";
    const lastMinute = SendGuard.countSince(recent, now - MINUTE_MS).count;
    if (AB.perRecipientPerMin > 0 && lastMinute >= AB.perRecipientPerMin) return "recipient per-minute cap";
    return null;
  }

  private checkBreaker(now: number): void {
    if (now < this.breakerUntil) {
      throw new SendBlockedError(
        "breaker",
        `Sending paused after repeated WhatsApp errors (${this.lastBreakerReason || "unknown"})`,
        this.breakerUntil - now,
      );
    }
  }

  // ── reply pacing + caps (every outbound message) ─────────────────────────

  private static prune(list: number[], olderThan: number): void {
    let i = 0;
    while (i < list.length && list[i] < olderThan) i++;
    if (i > 0) list.splice(0, i);
  }

  private static countSince(list: number[], since: number): { count: number; oldest: number } {
    let i = 0;
    while (i < list.length && list[i] < since) i++;
    return { count: list.length - i, oldest: list[i] ?? 0 };
  }

  /**
   * Call BEFORE every outbound message. Enforces the caps, then waits so sends
   * are spaced with jitter. Throws SendBlockedError if a cap is hit or the wait
   * would exceed `maxWaitMs`. Nothing is counted when it throws.
   */
  async reserveSend(phone: string, maxWaitMs: number): Promise<void> {
    if (!AB.enabled) return;
    const now = Date.now();
    this.checkBreaker(now);

    SendGuard.prune(this.sent, now - DAY_MS);
    const windows: Array<[number, number, string]> = [
      [MINUTE_MS, AB.perMinute, "per-minute"],
      [HOUR_MS, AB.perHour, "per-hour"],
      [DAY_MS, AB.perDay, "per-day"],
    ];
    for (const [span, limit, label] of windows) {
      if (limit <= 0) continue;
      const { count, oldest } = SendGuard.countSince(this.sent, now - span);
      if (count >= limit) {
        throw new SendBlockedError("rate_limit", `Send cap reached (${label}: ${limit})`, Math.max(1000, oldest + span - now));
      }
    }

    const rid = phone.replace(/\D/g, "");
    const recent = this.perRecipient.get(rid) ?? [];
    SendGuard.prune(recent, now - HOUR_MS);
    const perMin = SendGuard.countSince(recent, now - MINUTE_MS);
    if (AB.perRecipientPerMin > 0 && perMin.count >= AB.perRecipientPerMin) {
      throw new SendBlockedError("recipient_limit", `Too many messages to one recipient (per-minute: ${AB.perRecipientPerMin})`, Math.max(1000, perMin.oldest + MINUTE_MS - now));
    }
    if (AB.perRecipientPerHour > 0 && recent.length >= AB.perRecipientPerHour) {
      throw new SendBlockedError("recipient_limit", `Too many messages to one recipient (per-hour: ${AB.perRecipientPerHour})`, Math.max(1000, recent[0] + HOUR_MS - now));
    }

    const start = Math.max(now, this.nextSlotAt);
    const wait = start - now;
    if (wait > maxWaitMs) {
      throw new SendBlockedError("busy", "Too many messages queued for this number right now", wait);
    }
    this.nextSlotAt = start + AB.minGapMs + Math.random() * AB.gapJitterMs;

    // Count it only now that it is definitely going out.
    this.sent.push(start);
    recent.push(start);
    this.perRecipient.set(rid, recent);
    if (this.perRecipient.size > 2000) this.sweepRecipients(now);

    if (wait > 0) await sleep(wait);
  }

  private sweepRecipients(now: number): void {
    for (const [k, list] of this.perRecipient) {
      SendGuard.prune(list, now - HOUR_MS);
      if (list.length === 0) this.perRecipient.delete(k);
    }
  }

  // ── proactive sends ──────────────────────────────────────────────────────

  private proactiveUsedToday(now: number): number {
    const day = localParts(now, AB.tz).day;
    return this.state.proactiveDay?.day === day ? this.state.proactiveDay.count : 0;
  }

  proactiveCapToday(now = Date.now()): number {
    return proactiveTierForAgeDays(this.ageDays(now));
  }

  /**
   * Decide whether a proactive message may even be QUEUED. Throws
   * SendBlockedError (permanent=true when retrying can never help).
   */
  checkProactive(phone: string, queued: number): void {
    if (!AB.enabled) return;
    const now = Date.now();
    if (this.optOut.has(phone)) {
      throw new SendBlockedError("opted_out", "Customer asked not to receive messages", undefined, true);
    }
    const inbound = this.state.inbound[phone];
    if (!inbound || now - inbound > AB.proactiveMaxInboundAgeMs) {
      throw new SendBlockedError("no_recent_inbound", "Customer has not messaged recently, so no unsolicited message is sent", undefined, true);
    }
    const last = this.state.proactiveSent[phone];
    if (last && now - last < DAY_MS) {
      throw new SendBlockedError("duplicate", "A proactive message was already sent to this customer in the last 24 hours", undefined, true);
    }
    this.checkBreaker(now);
    const cap = this.proactiveCapToday(now);
    if (cap <= 0) {
      throw new SendBlockedError("warmup", "This number was paired very recently; proactive messages start after its first day", DAY_MS);
    }
    if (this.proactiveUsedToday(now) + queued >= cap) {
      throw new SendBlockedError("quota", `Daily proactive limit reached (${cap}/day for this number's age)`, HOUR_MS);
    }
    if (queued >= AB.proactiveQueueMax) {
      throw new SendBlockedError("queue_full", "Proactive queue is full", HOUR_MS);
    }
  }

  inProactiveHours(now = Date.now()): boolean {
    const { hour } = localParts(now, AB.tz);
    return hour >= AB.hoursStart && hour < AB.hoursEnd;
  }

  /** True once the hourly proactive budget has room again. */
  proactiveHourHasRoom(now = Date.now()): boolean {
    SendGuard.prune(this.proactiveHour, now - HOUR_MS);
    return AB.proactivePerHour <= 0 || this.proactiveHour.length < AB.proactivePerHour;
  }

  /** Re-validate right before sending (state may have changed while queued). */
  canSendProactiveNow(phone: string): SendBlockedError | null {
    try {
      this.checkProactive(phone, 0);
      return null;
    } catch (e) {
      return e instanceof SendBlockedError ? e : null;
    }
  }

  noteProactiveSent(phone: string): void {
    const now = Date.now();
    const day = localParts(now, AB.tz).day;
    const cur = this.state.proactiveDay;
    this.state.proactiveDay = cur && cur.day === day ? { day, count: cur.count + 1 } : { day, count: 1 };
    this.state.proactiveSent[phone] = now;
    this.proactiveHour.push(now);
    this.markDirty();
  }

  randomProactiveGapMs(): number {
    const lo = Math.min(AB.proactiveGapMinMs, AB.proactiveGapMaxMs);
    const hi = Math.max(AB.proactiveGapMinMs, AB.proactiveGapMaxMs);
    return lo + Math.random() * (hi - lo);
  }

  // ── diagnostics ──────────────────────────────────────────────────────────

  snapshot(queuedProactive = 0) {
    const now = Date.now();
    SendGuard.prune(this.sent, now - DAY_MS);
    return {
      enabled: AB.enabled,
      pairedAt: this.state.pairedAt ? new Date(this.state.pairedAt).toISOString() : null,
      numberAgeDays: Number(this.ageDays(now).toFixed(1)),
      sentLastMinute: SendGuard.countSince(this.sent, now - MINUTE_MS).count,
      sentLastHour: SendGuard.countSince(this.sent, now - HOUR_MS).count,
      sentLastDay: this.sent.length,
      limits: { perMinute: AB.perMinute, perHour: AB.perHour, perDay: AB.perDay },
      proactive: {
        usedToday: this.proactiveUsedToday(now),
        dailyCap: this.proactiveCapToday(now),
        queued: queuedProactive,
        inWindowNow: this.inProactiveHours(now),
        window: `${AB.hoursStart}-${AB.hoursEnd} ${AB.tz}`,
      },
      breaker: {
        open: now < this.breakerUntil,
        reopensInSeconds: Math.max(0, Math.round((this.breakerUntil - now) / 1000)),
        reason: this.lastBreakerReason || null,
        consecutiveFailures: this.consecutiveFailures,
      },
      trackedCustomers: Object.keys(this.state.inbound).length,
      optedOut: this.optOut.size,
    };
  }
}
