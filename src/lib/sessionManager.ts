import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
  type ConnectionState,
  type Contact,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { pino } from "pino";
import * as path from "path";
import * as fs from "fs";
import * as QRCode from "qrcode";
import { getSupabase } from "./supabase.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionStatus = "disconnected" | "connecting" | "qr" | "connected";

export interface SessionInfo {
  shopId: string;
  status: SessionStatus;
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const STORAGE_BUCKET = "product-images";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ─── Media Helpers ───────────────────────────────────────────────────────────

function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "application/pdf") return "pdf";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.startsWith("image/")) return "jpg";
  if (m.startsWith("audio/")) return "ogg";
  return "bin";
}

/** Extract just the digits of a jid's user part, dropping any device suffix
 *  (`user:12@server`) and the server domain. Used as a stable map key so the
 *  same contact matches whether addressed via @lid or @s.whatsapp.net. */
function jidUserDigits(jid: string | null | undefined): string {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

async function uploadInboundMedia(shopId: string, buffer: Buffer, mime: string): Promise<string | null> {
  try {
    const sb = getSupabase();
    const ext = extForMime(mime);
    const fileName = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const storagePath = `bridge/${shopId}/inbound/${fileName}`;
    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
      contentType: mime.split(";")[0].trim(),
      upsert: false,
    });
    if (error) {
      console.error("[sm] upload failed:", error.message);
      return null;
    }
    const { data } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    return data?.publicUrl || null;
  } catch (e) {
    console.error("[sm] uploadInboundMedia:", e);
    return null;
  }
}

// ─── Session Class ───────────────────────────────────────────────────────────

export class Session {
  private sock: WASocket | null = null;
  private info: SessionInfo;
  private pairingPhone: string | null = null;
  private pairingRequested = false;
  private authDir: string;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnecting = false;
  private processedMsgIds = new Set<string>();
  // Remember the exact jid a phone number last messaged from (handles @lid
  // contacts that can only be reached via their lid jid, not phone@s.whatsapp.net).
  private phoneToChatJid = new Map<string, string>();
  private chatJidPath: string;
  private chatJidDirty = false;
  // Maps a contact's LID digits -> their real phone number. Needed because
  // WhatsApp only ever exposes a *sender's* phone number, never a recipient's:
  // for an owner-sent (fromMe) message to a privacy-mode contact, the only
  // addressing we get is the contact's @lid jid. Persisted to disk so it
  // survives restarts.
  private lidToPhone = new Map<string, string>();
  private lidMapPath: string;
  private lidMapDirty = false;
  // Reverse index of lidToPhone's values — lets resolveLidViaUsync skip phones
  // whose LID we already know instead of re-querying them on every miss.
  private mappedPhones = new Set<string>();
  // Per-chat in-flight bridge-send counter, and resolved ids of bridge-initiated
  // sends. Distinguishes messages the bridge itself sent (admin-panel sends, bot
  // replies) from messages the owner typed manually on their paired phone.
  private pendingBridgeSends = new Map<string, number>();
  private bridgeSentMessageIds = new Set<string>();
  // Outbound/inbound proto bodies so Baileys can satisfy retry receipts
  // (fixes "Waiting for this message" when the phone asks for a resend).
  private recentMessages = new Map<string, proto.IMessage>();
  private placeholderResendRequested = new Set<string>();

  constructor(shopId: string, phoneForPairing?: string) {
    this.info = { shopId, status: "connecting", qrCode: null, pairingCode: null, phoneNumber: null };
    this.pairingPhone = phoneForPairing?.replace(/[^\d]/g, "") || null;
    this.authDir = path.join(SESSIONS_DIR, shopId);
    this.lidMapPath = path.join(this.authDir, "lid-map.json");
    this.chatJidPath = path.join(this.authDir, "chat-jids.json");
    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
  }

  // ─── LID ↔ phone map (persisted) ─────────────────────────────────────────

  private loadLidMap(): void {
    try {
      if (!fs.existsSync(this.lidMapPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.lidMapPath, "utf8")) as Record<string, string>;
      for (const [lid, phone] of Object.entries(raw)) {
        if (lid && phone) {
          this.lidToPhone.set(lid, phone);
          this.mappedPhones.add(phone);
        }
      }
      console.log(`[session ${this.info.shopId}] loaded ${this.lidToPhone.size} lid->phone mappings`);
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] failed to load lid map:`, e?.message || e);
    }
  }

  private saveLidMap(): void {
    if (!this.lidMapDirty) return;
    this.lidMapDirty = false;
    try {
      const obj: Record<string, string> = {};
      for (const [lid, phone] of this.lidToPhone) obj[lid] = phone;
      fs.writeFileSync(this.lidMapPath, JSON.stringify(obj), "utf8");
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] failed to save lid map:`, e?.message || e);
    }
  }

  private loadChatJids(): void {
    try {
      if (!fs.existsSync(this.chatJidPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.chatJidPath, "utf8")) as Record<string, string>;
      for (const [phone, jid] of Object.entries(raw)) {
        if (phone && jid) this.phoneToChatJid.set(phone, jid);
      }
      console.log(`[session ${this.info.shopId}] loaded ${this.phoneToChatJid.size} chat jids`);
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] failed to load chat jids:`, e?.message || e);
    }
  }

  private saveChatJids(): void {
    if (!this.chatJidDirty) return;
    this.chatJidDirty = false;
    try {
      const obj: Record<string, string> = {};
      for (const [phone, jid] of this.phoneToChatJid) obj[phone] = jid;
      fs.writeFileSync(this.chatJidPath, JSON.stringify(obj), "utf8");
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] failed to save chat jids:`, e?.message || e);
    }
  }

  /** Remember the outbound jid for a phone. Real mobiles stay on @s.whatsapp.net.
   *  Sending those chats to @lid is rejected with 479 (smax-invalid). */
  private rememberChatJid(phoneDigits: string, jid: string): void {
    const phone = String(phoneDigits || "").replace(/\D/g, "");
    if (!phone || !jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;
    let dest = jid;
    if (dest.includes("@lid") && this.phoneFromPn(phone)) {
      dest = `${phone}@s.whatsapp.net`;
    }
    if (this.phoneToChatJid.get(phone) === dest) return;
    this.phoneToChatJid.set(phone, dest);
    this.chatJidDirty = true;
    this.saveChatJids();
  }

  /** A PN jid's digits, or "" when this is a LID / not a real mobile number. */
  private phoneFromPn(pn: string | null | undefined): string {
    const raw = String(pn || "");
    if (!raw || raw.includes("@lid")) return "";
    const digits = jidUserDigits(raw);
    if (digits.length < 8 || digits.length > 15) return "";
    // Bare 14–15 digit ids are usually LIDs, not E.164 mobiles.
    if (!raw.includes("@s.whatsapp.net") && !raw.includes("@c.us") && digits.length >= 14) return "";
    return digits;
  }

  private cacheMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
    if (!id || !message) return;
    this.recentMessages.set(id, message);
    if (this.recentMessages.size > 300) {
      const first = this.recentMessages.keys().next().value;
      if (first) this.recentMessages.delete(first);
    }
  }

  private keyFields(key: WAMessageKey): Record<string, string | undefined> {
    return key as unknown as Record<string, string | undefined>;
  }

  private lidMapping(): {
    getPNForLID?: (jid: string) => Promise<string | null>;
    getLIDForPN?: (jid: string) => Promise<string | null>;
    storeLIDPNMappings?: (pairs: Array<{ lid: string; pn: string }>) => Promise<void>;
  } | undefined {
    return (this.sock as { signalRepository?: { lidMapping?: ReturnType<Session["lidMapping"]> } } | null)?.signalRepository?.lidMapping;
  }

  private keyPn(key: WAMessageKey): string {
    const extra = this.keyFields(key);
    return (
      this.phoneFromPn(extra.remoteJidAlt) ||
      this.phoneFromPn(extra.senderPn) ||
      this.phoneFromPn(extra.participantPn) ||
      this.phoneFromPn(extra.participantAlt) ||
      ""
    );
  }

  private keyLid(key: WAMessageKey): string {
    const extra = this.keyFields(key);
    const jid = key.remoteJid || "";
    if (jid.includes("@lid")) return jid;
    if (String(extra.remoteJidAlt || "").includes("@lid")) return String(extra.remoteJidAlt);
    if (extra.senderLid) return extra.senderLid;
    if (extra.participantLid) return extra.participantLid;
    return "";
  }

  private async persistLidPn(lidJid: string | null | undefined, phone: string): Promise<void> {
    const ph = String(phone || "").replace(/\D/g, "");
    if (!lidJid || !ph) return;
    this.rememberLid(lidJid, ph);
    try {
      const mapping = this.lidMapping();
      if (!mapping?.storeLIDPNMappings) return;
      const lid = lidJid.includes("@") ? lidJid : `${jidUserDigits(lidJid)}@lid`;
      await mapping.storeLIDPNMappings([{ lid, pn: `${ph}@s.whatsapp.net` }]);
    } catch {
      /* mapping store is best-effort */
    }
  }

  /**
   * If the first messages were stored under a LID (no phone yet) and WhatsApp
   * later reveals the real number, move that chat onto the real number so the
   * dashboard and bot don't stay stuck on the LID.
   */
  private async migrateStoredPhone(fromDigits: string, toDigits: string): Promise<void> {
    if (!fromDigits || !toDigits || fromDigits === toDigits) return;
    try {
      const sb = getSupabase();
      const shopId = this.info.shopId;
      const { data: taken } = await sb
        .from("customers")
        .select("phone_number")
        .eq("shop_id", shopId)
        .eq("phone_number", toDigits)
        .maybeSingle();
      await sb.from("messages").update({ phone_number: toDigits }).eq("shop_id", shopId).eq("phone_number", fromDigits);
      if (taken) {
        await sb.from("customers").delete().eq("shop_id", shopId).eq("phone_number", fromDigits);
      } else {
        await sb.from("customers").update({ phone_number: toDigits }).eq("shop_id", shopId).eq("phone_number", fromDigits);
      }
      console.log(`[session ${shopId}] moved chat ${fromDigits} -> ${toDigits}`);
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] lid phone migrate failed:`, e?.message || e);
    }
  }

  /** Record a lid<->phone association from any source. */
  private rememberLid(lidJidOrDigits: string | null | undefined, phone: string): void {
    const lid = jidUserDigits(lidJidOrDigits);
    const ph = String(phone || "").replace(/\D/g, "");
    if (!lid || !ph || lid === ph) return;
    if (this.lidToPhone.get(lid) === ph) return;
    this.lidToPhone.set(lid, ph);
    this.mappedPhones.add(ph);
    this.lidMapDirty = true;
    this.saveLidMap();
  }

  getInfo(): SessionInfo {
    return { ...this.info };
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  async connect(): Promise<void> {
    // connect() is re-entered on every reconnect — only read from disk once.
    if (this.lidToPhone.size === 0) this.loadLidMap();
    if (this.phoneToChatJid.size === 0) this.loadChatJids();

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.saveCreds = saveCreds;

    const sock = makeWASocket({
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      maxMsgRetryCount: 8,
      shouldIgnoreJid: (jid) => jid === "status@broadcast",
      getMessage: async (key) => {
        const id = key?.id || "";
        return (id && this.recentMessages.get(id)) || undefined;
      },
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => this.onConnectionUpdate(update));
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) {
        // Newly paired numbers often deliver live chats as "append" during the
        // first sync. Older sessions only see "notify", so they were unaffected.
        // Accept recent appends; skip the historical backlog so the bot doesn't
        // reply to old conversations.
        if (type === "append") {
          const rawTs = Number(msg.messageTimestamp || 0);
          const tsMs = rawTs > 1e12 ? rawTs : rawTs * 1000;
          if (!tsMs || Date.now() - tsMs > 3 * 60 * 1000) continue;
        } else if (type !== "notify") {
          continue;
        }
        this.dispatchWaMessage(msg);
      }
    });
    sock.ev.on("messages.update", (updates) => {
      for (const u of updates || []) {
        if (!u?.update?.message || !u.key) continue;
        this.dispatchWaMessage({ key: u.key, message: u.update.message } as WAMessage);
      }
    });

    // Contact syncs are the richest source of lid<->phone pairs. Baileys 7
    // Contact is { id, lid?, phoneNumber? }.
    const onContacts = (contacts: Array<Partial<Contact> & { id?: string }>) => {
      for (const c of contacts || []) {
        const id = c.id || "";
        const phoneJid = c.phoneNumber || (!id.includes("@lid") ? id : "");
        const lidJid = c.lid || (id.includes("@lid") ? id : "");
        const phone = this.phoneFromPn(phoneJid);
        if (lidJid && phone) {
          void this.persistLidPn(lidJid.includes("@") ? lidJid : `${jidUserDigits(lidJid)}@lid`, phone);
          void this.migrateStoredPhone(jidUserDigits(lidJid), phone);
        }
      }
    };
    sock.ev.on("contacts.upsert", onContacts);
    sock.ev.on("contacts.update", onContacts);

    sock.ev.on("lid-mapping.update" as any, (pair: { pn?: string; lid?: string }) => {
      const phone = this.phoneFromPn(pair?.pn);
      if (pair?.lid && phone) {
        void this.persistLidPn(pair.lid, phone);
        void this.migrateStoredPhone(jidUserDigits(pair.lid), phone);
      }
    });

    // Emitted when a contact shares their phone number for a LID chat.
    sock.ev.on("chats.phoneNumberShare" as any, (update: { lid?: string; jid?: string }) => {
      const phone = this.phoneFromPn(update?.jid);
      if (update?.lid && phone) {
        void this.persistLidPn(update.lid, phone);
        void this.migrateStoredPhone(jidUserDigits(update.lid), phone);
      }
    });

    // Phone pairing: request the code once creds are not yet registered.
    if (this.pairingPhone && !sock.authState.creds.registered && !this.pairingRequested) {
      this.pairingRequested = true;
      // Small delay lets the socket establish before requesting a code.
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(this.pairingPhone!);
          this.info.pairingCode = code;
          this.info.status = "qr";
          this.info.qrCode = null;
          console.log(`[session ${this.info.shopId}] PAIRING CODE: ${code}`);
        } catch (err: any) {
          console.error(`[session ${this.info.shopId}] pairing request failed:`, err?.message || err);
          this.pairingRequested = false;
        }
      }, 3000);
    }
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !this.pairingPhone) {
      try {
        this.info.qrCode = await QRCode.toDataURL(qr);
        this.info.status = "qr";
      } catch (err) {
        console.error(`[session ${this.info.shopId}] QR encode error:`, err);
      }
    }

    if (connection === "open") {
      this.info.status = "connected";
      this.info.qrCode = null;
      this.info.pairingCode = null;
      try {
        const me = this.sock?.authState?.creds?.me as { id?: string; jid?: string; phoneNumber?: string } | undefined;
        const id = me?.id || this.sock?.user?.id || "";
        const phoneJid =
          this.phoneFromPn(me?.phoneNumber) ||
          this.phoneFromPn(me?.jid) ||
          (!id.includes("@lid") ? jidUserDigits(id) : "");
        this.info.phoneNumber = phoneJid || null;
        if (!this.info.phoneNumber && id.includes("@lid")) {
          console.warn(`[session ${this.info.shopId}] connected identity is a LID (${id}); waiting for the phone jid`);
        }
      } catch {
        this.info.phoneNumber = null;
      }
      console.log(`[session ${this.info.shopId}] ready (${this.info.phoneNumber})`);
      await this.markConnected(true);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const timedOut = statusCode === DisconnectReason.timedOut || statusCode === 515;

      if (loggedOut) {
        this.info.status = "disconnected";
        await this.markConnected(false);
        console.log(`[session ${this.info.shopId}] logged out — clearing auth`);
        try {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          fs.mkdirSync(this.authDir, { recursive: true });
        } catch { /* ignore */ }
        return;
      }

      // Timeout errors (515) should NOT clear auth - just reconnect
      if (timedOut) {
        console.warn(`[session ${this.info.shopId}] connection timed out — reconnecting with existing auth`);
        this.info.status = "connecting";
        await this.markConnected(false);
        
        if (!this.reconnecting) {
          this.reconnecting = true;
          setTimeout(() => {
            this.reconnecting = false;
            this.connect().catch((e) => console.error(`[session ${this.info.shopId}] reconnect failed:`, e));
          }, 5000); // Wait 5 seconds before reconnecting
        }
        return;
      }

      // Any other close reason (including the expected "restart required"
      // Baileys sends right after a QR/pairing scan) means we're about to
      // open a fresh socket and reconnect automatically. Report "connecting"
      // rather than "disconnected" here — the frontend treats "disconnected"
      // as a final state and stops polling, which would otherwise strand the
      // UI on the QR screen even though the bridge goes on to connect
      // successfully a few seconds later.
      this.info.status = "connecting";
      await this.markConnected(false);

      if (!this.reconnecting) {
        this.reconnecting = true;
        console.warn(`[session ${this.info.shopId}] connection closed (reconnecting) — reason: ${statusCode ?? "unknown"}`);
        setTimeout(() => {
          this.reconnecting = false;
          this.connect().catch((e) => console.error(`[session ${this.info.shopId}] reconnect failed:`, e));
        }, 3000);
      }
    }
  }

  private dispatchWaMessage(msg: WAMessage): void {
    const jid = msg.key.remoteJid || "";
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;
    if (msg.key.fromMe) {
      if (this.isBridgeInitiated(msg)) return;
      this.handleOwnerSentMessage(msg).catch((e) => console.error("[msg-owner]", e));
      return;
    }
    this.handleIncoming(msg).catch((e) => console.error("[msg]", e));
  }

  private isChatContent(content: proto.IMessage | null | undefined): content is proto.IMessage {
    if (!content) return false;
    if (content.protocolMessage || content.senderKeyDistributionMessage || content.reactionMessage) return false;
    return Boolean(
      content.conversation ||
      content.extendedTextMessage ||
      content.imageMessage ||
      content.audioMessage ||
      content.videoMessage ||
      content.documentMessage ||
      content.stickerMessage,
    );
  }

  // ─── Bridge-send tracking ────────────────────────────────────────────────

  private async trackBridgeSend<T extends { key?: { id?: string | null } } | null | undefined>(
    jid: string,
    fn: () => Promise<T>
  ): Promise<T> {
    this.pendingBridgeSends.set(jid, (this.pendingBridgeSends.get(jid) || 0) + 1);
    try {
      const result = await fn();
      const sent = result as { key?: { id?: string | null }; message?: proto.IMessage } | null | undefined;
      const id = sent?.key?.id || "";
      if (id) {
        this.bridgeSentMessageIds.add(id);
        this.cacheMessage(id, sent?.message);
        setTimeout(() => this.bridgeSentMessageIds.delete(id), 15000);
      }
      return result;
    } finally {
      setTimeout(() => {
        const cur = this.pendingBridgeSends.get(jid) || 0;
        if (cur <= 1) this.pendingBridgeSends.delete(jid);
        else this.pendingBridgeSends.set(jid, cur - 1);
      }, 2000);
    }
  }

  private isBridgeInitiated(msg: WAMessage): boolean {
    const id = msg.key.id || "";
    const jid = msg.key.remoteJid || "";
    if (id && this.bridgeSentMessageIds.has(id)) {
      this.bridgeSentMessageIds.delete(id);
      return true;
    }
    return (this.pendingBridgeSends.get(jid) || 0) > 0;
  }

  // ─── Incoming Message Handler ────────────────────────────────────────────

  private resolveRealNumber(msg: WAMessage): string {
    const jid = msg.key.remoteJid || "";
    // Baileys 7 puts the PN on remoteJidAlt when the chat is @lid.
    const fromPn = this.keyPn(msg.key);
    if (fromPn) return fromPn;
    if (jid.includes("@lid")) {
      const known = this.lidToPhone.get(jidUserDigits(jid));
      if (known) return known;
    }
    if (!jid.includes("@lid")) return jidUserDigits(jid);
    return jidUserDigits(jid);
  }

  private async resolveRealNumberAsync(msg: WAMessage): Promise<string> {
    const jid = msg.key.remoteJid || "";
    const sync = this.resolveRealNumber(msg);
    const lidDigits = jid.includes("@lid") ? jidUserDigits(jid) : "";
    if (!lidDigits || (sync && sync !== lidDigits && this.phoneFromPn(sync))) return sync;
    try {
      const pn = await this.lidMapping()?.getPNForLID?.(jid);
      const mapped = this.phoneFromPn(pn);
      if (mapped) {
        void this.persistLidPn(jid, mapped);
        return mapped;
      }
    } catch {
      /* fall through */
    }
    return sync;
  }

  private async resolveOwnerCounterpartyNumber(msg: WAMessage): Promise<string> {
    const fromPn = this.resolveRealNumber(msg);
    if (fromPn && this.phoneFromPn(fromPn)) return fromPn;

    const jid = msg.key.remoteJid || "";
    if (!jid.includes("@lid")) return fromPn;

    const lid = jidUserDigits(jid);
    const known = this.lidToPhone.get(lid);
    if (known) return known;

    const resolved = await this.resolveLidViaUsync(lid).catch(() => "");
    if (resolved) return resolved;

    console.warn(`[session ${this.info.shopId}] could not map lid ${lid} to a phone number; falling back to lid digits`);
    return fromPn;
  }

  /** Look up this shop's known customer numbers via usync and find which one
   *  owns the given LID. Caches every mapping it learns. */
  private async resolveLidViaUsync(lid: string): Promise<string> {
    if (!this.sock) return "";
    try {
      const sb = getSupabase();
      const { data } = await sb
        .from("customers")
        .select("phone_number")
        .eq("shop_id", this.info.shopId)
        .order("created_at", { ascending: false })
        .limit(200);

      const phones = (data || [])
        .map((r) => String((r as { phone_number?: string }).phone_number || "").replace(/\D/g, ""))
        .filter((p) => p.length >= 8 && p.length <= 13);
      if (phones.length === 0) return "";

      const mapping = this.lidMapping();
      if (mapping?.getLIDForPN) {
        for (const p of phones) {
          const lidJid = await mapping.getLIDForPN(`${p}@s.whatsapp.net`);
          if (lidJid) {
            this.rememberLid(lidJid, p);
            if (jidUserDigits(lidJid) === lid) return p;
          }
          const hit = this.lidToPhone.get(lid);
          if (hit) return hit;
        }
      }

      const onWhatsApp = (this.sock as { onWhatsApp?: (...jids: string[]) => Promise<Array<{ jid?: string; lid?: string }> | undefined> }).onWhatsApp;
      if (onWhatsApp) {
        for (let i = 0; i < phones.length; i += 20) {
          const batch = phones.slice(i, i + 20);
          const results = await onWhatsApp(...batch.map((p) => `${p}@s.whatsapp.net`));
          for (const r of results || []) {
            const phone = this.phoneFromPn(r?.jid) || jidUserDigits(r?.jid);
            const rLid = jidUserDigits(r?.lid);
            if (rLid && phone) this.rememberLid(rLid, phone);
          }
          const hit = this.lidToPhone.get(lid);
          if (hit) return hit;
        }
      }
    } catch (e: any) {
      console.warn(`[session ${this.info.shopId}] usync lid lookup failed:`, e?.message || e);
    }
    return "";
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid || "";
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || msg.key.fromMe) return;

    const msgId = msg.key.id || "";

    // Unwrap envelope types (documentWithCaptionMessage, viewOnceMessage,
    // ephemeralMessage, editedMessage, …) so the real content (e.g. the
    // actual documentMessage) is what we check below. Without this, a PDF
    // sent normally from the WhatsApp app arrives wrapped in
    // documentWithCaptionMessage and is silently dropped as an empty text
    // message.
    const content = normalizeMessageContent(msg.message);
    if (!this.isChatContent(content)) {
      if (!content && msgId && !this.placeholderResendRequested.has(msgId)) {
        this.placeholderResendRequested.add(msgId);
        setTimeout(() => this.placeholderResendRequested.delete(msgId), 120000);
        console.warn(`[msg] still encrypted, asking phone to resend: jid=${jid} id=${msgId}`);
        void (this.sock as { requestPlaceholderResend?: (key: WAMessageKey) => Promise<unknown> } | null)
          ?.requestPlaceholderResend?.(msg.key)
          .catch((e: { message?: string }) =>
            console.warn(`[msg] placeholder resend failed:`, e?.message || e),
          );
      }
      return;
    }
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 1000) this.processedMsgIds.clear();
    }

    const type = Object.keys(content)[0] || "";
    console.log(
      `[msg] incoming: type=${type}, jid=${jid}, alt=${this.keyFields(msg.key).remoteJidAlt || "-"}`,
    );

    const sb = getSupabase();
    const shopId = this.info.shopId;
    const phone = await this.resolveRealNumberAsync(msg);
    if (!phone) return;

    this.cacheMessage(msgId, msg.message);

    const lidDigits = jid.includes("@lid") ? jidUserDigits(jid) : "";
    // Remember which exact jid this phone number messaged from, so replies
    // (especially to @lid contacts) go back to the correct chat after a restart.
    this.rememberChatJid(phone, jid);
    if (lidDigits && phone !== lidDigits) {
      this.rememberChatJid(lidDigits, jid);
      void this.migrateStoredPhone(lidDigits, phone);
    }
    const extraLid = this.keyLid(msg.key);
    if (extraLid) void this.persistLidPn(extraLid, phone);
    if (jid.includes("@lid")) void this.persistLidPn(jid, phone);

    let textContent = "";
    let mediaUrl: string | null = null;
    let mediaType: "audio" | "image" | "document" | null = null;
    let caption = "";

    const isMedia = Boolean(content.imageMessage || content.audioMessage || content.videoMessage || content.documentMessage);

    // Count this photo/file before download. Album items are handled in
    // parallel; if we only debounce after upload, 10 photos finish seconds
    // apart and still produce 10 bot replies.
    if (isMedia) this.beginMediaBotBurst(shopId, phone);

    try {
      if (isMedia) {
        caption = content.imageMessage?.caption || content.videoMessage?.caption || "";
        try {
          const buffer = (await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger, reuploadRequest: this.sock!.updateMediaMessage },
          )) as Buffer;

          const mime =
            content.imageMessage?.mimetype ||
            content.audioMessage?.mimetype ||
            content.videoMessage?.mimetype ||
            content.documentMessage?.mimetype ||
            "";

          const url = await uploadInboundMedia(shopId, buffer, mime);
          if (url) {
            mediaUrl = url;
            textContent = url;
            if (content.audioMessage || mime.includes("audio") || mime.includes("ogg") || mime.includes("opus")) {
              mediaType = "audio";
            } else if (content.imageMessage || mime.startsWith("image/")) {
              mediaType = "image";
            } else if (mime === "application/pdf" || content.documentMessage) {
              // Bank receipts and invoices are usually PDFs — pass them to the
              // bot so it can read and verify them (Gemini handles PDF natively).
              mediaType = "document";
            }
            console.log(`[msg] media uploaded: type=${mediaType}, mime=${mime}, url=${url.slice(0, 80)}`);
          } else {
            console.warn(`[msg] media upload returned no URL — mime=${mime}`);
          }
        } catch (e: any) {
          console.warn(`[msg] media download failed:`, e?.message || e);
        }
        if (!textContent) {
          textContent = content.audioMessage ? "🎤 Voice message" : "📎 Media";
        }
      } else {
        textContent = (content.conversation || content.extendedTextMessage?.text || "").trim();
      }

      if (!textContent) return;

      await sb.from("customers").upsert(
        { shop_id: shopId, phone_number: phone, bot_active: true },
        { onConflict: "shop_id,phone_number", ignoreDuplicates: true },
      );

      const row: Record<string, unknown> = { shop_id: shopId, phone_number: phone, role: "user", content: textContent };
      if (msgId) row.wa_message_id = msgId;
      await sb.from("messages").insert(row);

      // Text sent to the bot: the caption for media, or the plain text body otherwise.
      const textForBot = isMedia && !mediaType ? "" : (caption.trim() || textContent);
      if (isMedia) {
        this.queueMediaBotBurst(shopId, phone, {
          text: textForBot,
          mediaType,
          mediaUrl,
          messageId: msgId || null,
        });
      } else if (textForBot || mediaType) {
        this.triggerBot(shopId, phone, textForBot, mediaType, mediaUrl, msgId || null).catch(
          (e) => console.error("[bot]", e),
        );
      }
    } finally {
      if (isMedia) this.endMediaBotBurst(shopId, phone);
    }
  }

  // ── Media-burst coalesce ────────────────────────────────────────────────
  // WhatsApp albums arrive as many messages, each downloaded in parallel.
  // Wait until every in-flight download for this customer has finished and
  // the chat has been quiet for MEDIA_BOT_BURST_MS, then call the bot once
  // (last photo in the burst). Text messages still fire immediately.
  private static readonly MEDIA_BOT_BURST_MS = 2500;

  private mediaBotBursts = new Map<string, {
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: number;
    shopId: string;
    phone: string;
    pending: {
      text: string;
      mediaType: "audio" | "image" | "document" | null;
      mediaUrl: string | null;
      messageId: string | null;
    } | null;
  }>();

  private mediaBurstKey(shopId: string, phone: string): string {
    return `${shopId}:${phone}`;
  }

  private beginMediaBotBurst(shopId: string, phone: string): void {
    const key = this.mediaBurstKey(shopId, phone);
    const burst = this.mediaBotBursts.get(key) ?? {
      timer: null,
      inFlight: 0,
      shopId,
      phone,
      pending: null,
    };
    burst.inFlight += 1;
    if (burst.timer) {
      clearTimeout(burst.timer);
      burst.timer = null;
    }
    this.mediaBotBursts.set(key, burst);
  }

  private queueMediaBotBurst(
    shopId: string,
    phone: string,
    pending: {
      text: string;
      mediaType: "audio" | "image" | "document" | null;
      mediaUrl: string | null;
      messageId: string | null;
    },
  ): void {
    const burst = this.mediaBotBursts.get(this.mediaBurstKey(shopId, phone));
    if (!burst) return;
    if (pending.text || pending.mediaType) burst.pending = pending;
  }

  private endMediaBotBurst(shopId: string, phone: string): void {
    const key = this.mediaBurstKey(shopId, phone);
    const burst = this.mediaBotBursts.get(key);
    if (!burst) return;
    burst.inFlight = Math.max(0, burst.inFlight - 1);
    if (burst.inFlight === 0) this.armMediaBotBurst(key);
  }

  private armMediaBotBurst(key: string): void {
    const burst = this.mediaBotBursts.get(key);
    if (!burst) return;
    if (burst.timer) clearTimeout(burst.timer);
    burst.timer = setTimeout(() => {
      const current = this.mediaBotBursts.get(key);
      if (!current) return;
      if (current.inFlight > 0) {
        this.armMediaBotBurst(key);
        return;
      }
      const pending = current.pending;
      this.mediaBotBursts.delete(key);
      if (!pending) return;
      console.log(`[bot] media burst settled for ${current.phone} — one reply`);
      this.triggerBot(
        current.shopId,
        current.phone,
        pending.text,
        pending.mediaType,
        pending.mediaUrl,
        pending.messageId,
      ).catch((e) => console.error("[bot]", e));
    }, Session.MEDIA_BOT_BURST_MS);
  }

  private async handleOwnerSentMessage(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid || "";
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

    const msgId = msg.key.id || "";
    const content = normalizeMessageContent(msg.message);
    if (!this.isChatContent(content)) return;
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 1000) this.processedMsgIds.clear();
    }

    const type = Object.keys(content)[0] || "";
    console.log(`[msg] owner-sent (manual): type=${type}, jid=${jid.slice(0, 40)}, alt=${this.keyFields(msg.key).remoteJidAlt || "-"}`);

    const sb = getSupabase();
    const shopId = this.info.shopId;
    const phone = await this.resolveOwnerCounterpartyNumber(msg);
    if (!phone) return;

    this.rememberChatJid(phone, jid);
    const lidDigits = jid.includes("@lid") ? jidUserDigits(jid) : "";
    if (lidDigits && phone !== lidDigits) void this.migrateStoredPhone(lidDigits, phone);
    if (jid.includes("@lid")) this.rememberLid(jid, phone);

    let textContent = "";
    const isMedia = Boolean(content.imageMessage || content.audioMessage || content.videoMessage || content.documentMessage);

    if (isMedia) {
      const caption = content.imageMessage?.caption || content.videoMessage?.caption || "";
      try {
        const buffer = (await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger, reuploadRequest: this.sock!.updateMediaMessage },
        )) as Buffer;

        const mime =
          content.imageMessage?.mimetype ||
          content.audioMessage?.mimetype ||
          content.videoMessage?.mimetype ||
          content.documentMessage?.mimetype ||
          "";

        const url = await uploadInboundMedia(shopId, buffer, mime);
        if (url) {
          textContent = url;
        }
      } catch (e: any) {
        console.warn(`[msg] owner-sent media download failed:`, e?.message || e);
      }
      if (!textContent) {
        textContent = content.audioMessage ? "🎤 Voice message" : "📎 Media";
      }
      // caption is currently unused for the persisted row (mirrors handleIncoming,
      // which stores the media URL as content and only forwards caption to the bot —
      // owner-sent messages never go to the bot, so caption is intentionally dropped
      // here rather than silently duplicated into content).
    } else {
      textContent = (content.conversation || content.extendedTextMessage?.text || "").trim();
    }

    if (!textContent) return;

    await sb.from("customers").upsert(
      { shop_id: shopId, phone_number: phone, bot_active: true },
      { onConflict: "shop_id,phone_number", ignoreDuplicates: true },
    );

    const row: Record<string, unknown> = { shop_id: shopId, phone_number: phone, role: "admin", content: textContent };
    if (msgId) row.wa_message_id = msgId;
    await sb.from("messages").insert(row);
    // Deliberately no triggerBot call — an owner's manual message must never
    // cause an automated bot reply.
  }

  // ─── Bot Trigger ─────────────────────────────────────────────────────────

  private async triggerBot(shopId: string, phone: string, text: string, mediaType: "audio" | "image" | "document" | null, mediaUrl: string | null, messageId: string | null = null): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL?.trim();
    const bridgeSecret = process.env.BRIDGE_SECRET?.trim() || "";
    if (!frontendUrl) return;

    try {
      const payload: Record<string, string> = { shop_id: shopId, phone_number: phone, text };
      // Pass the WhatsApp message id so /api/wa-web-bot can deduplicate retried
      // or duplicate deliveries of the same message (idempotency guard).
      if (messageId) payload.message_id = messageId;
      if (mediaType && mediaUrl) {
        payload.media_type = mediaType;
        payload.media_url = mediaUrl;
      }

      const res = await fetch(`${frontendUrl}/api/wa-web-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-secret": bridgeSecret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000), // 45 second timeout to prevent hanging
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        bubbles?: string[];
        images?: string[];
        audios?: string[];
        reviews_link?: string;
      };

      if (!res.ok || !data?.ok) return;

      // Small random delay before starting to send (simulates bot "thinking")
      await randomDelay(800, 1500);

      // Send images with random delays (typing indicator shown automatically)
      for (const url of (data.images || []).slice(0, 6)) {
        try {
          await this.sendImage(phone, url); // Typing indicator built-in
          await randomDelay(1000, 2000); // Random 1-2 seconds between images
        } catch (e) {
          console.error(`[bot] image send failed for ${phone}:`, e);
        }
      }

      // Send audio with random delays (typing indicator shown automatically)
      for (const url of (data.audios || []).slice(0, 2)) {
        try {
          await this.sendAudio(phone, { url }); // Typing indicator built-in
          await randomDelay(1000, 2000); // Random 1-2 seconds between audio
        } catch (e) {
          console.error(`[bot] audio send failed for ${phone}:`, e);
        }
      }

      // Send text bubbles with typing indicators and random delays
      for (const b of data.bubbles || []) {
        if (!b.trim()) continue;
        try {
          await this.sendText(phone, b); // Typing indicator built-in (based on message length)
          await randomDelay(800, 1500); // Random pause between messages
        } catch (e) {
          console.error(`[bot] text send failed for ${phone}:`, e);
        }
      }

      if (data.reviews_link) {
        try { 
          await randomDelay(800, 1200); // Small pause before review link
          await this.sendText(phone, `⭐ More reviews: ${data.reviews_link}`); 
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.error("[triggerBot]", e);
    }
  }

  // ─── Send Methods ────────────────────────────────────────────────────────

  /**
   * Resolve a bare phone number to the correct outbound JID. Prefers the exact
   * jid we last saw this phone number message from — critical for @lid
   * contacts, since phone@s.whatsapp.net does not reach them.
   */
  private toJid(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    const remembered = this.phoneToChatJid.get(digits);
    // Real phone numbers must be sent as @s.whatsapp.net. Baileys 7 maps LID
    // internally. Forcing @lid made WhatsApp ack 479 and drop the message.
    if (this.phoneFromPn(digits) || (digits.length >= 8 && digits.length <= 13)) {
      if (remembered && !remembered.includes("@lid")) return remembered;
      return `${digits}@s.whatsapp.net`;
    }
    if (remembered) return remembered;
    const mappedPhone = this.lidToPhone.get(digits);
    if (mappedPhone) return `${mappedPhone}@s.whatsapp.net`;
    if (digits.length >= 14) return `${digits}@lid`;
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Show typing indicator to customer (makes bot look more human).
   * Simulates "typing..." bubble in WhatsApp.
   */
  private async showTyping(phone: string, durationMs: number = 2000): Promise<void> {
    if (!this.sock) return;
    const jid = this.toJid(phone);
    try {
      // Start composing (typing indicator)
      await this.sock.sendPresenceUpdate("composing", jid);
      
      // Wait for the typing duration
      await sleep(durationMs);
      
      // Stop composing (remove typing indicator)
      await this.sock.sendPresenceUpdate("paused", jid);
    } catch (e) {
      // Typing indicators are non-critical, ignore errors
      console.warn(`[session ${this.info.shopId}] typing indicator failed:`, e);
    }
  }

  async sendText(phone: string, message: string, showTyping: boolean = true): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    
    // Show typing indicator before sending (simulate human typing)
    if (showTyping) {
      const typingDuration = Math.min(Math.max(message.length * 30, 800), 3000);
      await this.showTyping(phone, typingDuration);
    }
    
    console.log(`[send] text to ${jid} (from ${phone})`);
    const sent = await this.trackBridgeSend(jid, () => this.sock!.sendMessage(jid, { text: message }));
    return { id: sent?.key?.id || "" };
  }

  async sendImage(phone: string, imageUrl: string, caption?: string, showTyping: boolean = true): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    
    // Show typing indicator before sending image
    if (showTyping) {
      await this.showTyping(phone, 1500); // 1.5 seconds typing for images
    }
    
    try {
      // Fetch the bytes ourselves — more reliable than letting Baileys fetch a
      // remote URL, which can fail silently on redirects/slow responses.
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`Failed to fetch image_url: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const sent = await this.trackBridgeSend(jid, () =>
        this.sock!.sendMessage(jid, { image: buffer, caption: caption || undefined }),
      );
      return { id: sent?.key?.id || "" };
    } catch (err) {
      console.error(`[session ${this.info.shopId}] sendImage fetch failed, falling back to url mode:`, err);
      const sent = await this.trackBridgeSend(jid, () =>
        this.sock!.sendMessage(jid, { image: { url: imageUrl }, caption: caption || undefined }),
      );
      return { id: sent?.key?.id || "" };
    }
  }

  async sendAudio(
    phone: string,
    audio: { url?: string; base64?: string; mimetype?: string },
    showTyping: boolean = true,
  ): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);

    // Show typing indicator before sending audio
    if (showTyping) {
      await this.showTyping(phone, 1500); // 1.5 seconds typing for audio
    }

    // Baileys needs the actual audio bytes (a Buffer), not a remote URL, to
    // reliably produce a playable voice note with the correct waveform/ptt
    // flag. Prefer base64 bytes; only fetch the URL as a fallback.
    let buffer: Buffer;
    if (audio.base64) {
      buffer = Buffer.from(audio.base64, "base64");
    } else if (audio.url) {
      const res = await fetch(audio.url);
      if (!res.ok) throw new Error(`Failed to fetch audio_url: ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error("No audio data provided");
    }

    const sent = await this.trackBridgeSend(jid, () =>
      this.sock!.sendMessage(jid, {
        audio: buffer,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      }),
    );
    return { id: sent?.key?.id || "" };
  }

  async editMessage(waMessageId: string, phone: string, newText: string): Promise<void> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    await this.sock.sendMessage(jid, {
      text: newText,
      edit: { remoteJid: jid, id: waMessageId, fromMe: true },
    });
  }

  async deleteMessage(waMessageId: string, phone: string): Promise<void> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    await this.sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: waMessageId, fromMe: true },
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  private async markConnected(connected: boolean): Promise<void> {
    try {
      await getSupabase().from("businesses").update({ wa_web_connected: connected }).eq("id", this.info.shopId);
    } catch { /* ignore */ }
  }

  /** Close the local socket WITHOUT telling WhatsApp's servers to invalidate
   *  the session. Safe to call on process shutdown/restart — the on-disk
   *  creds remain valid and the session reconnects automatically next boot,
   *  with no QR/pairing re-scan required. */
  async closeSocket(): Promise<void> {
    this.saveLidMap();
    try { this.sock?.end(undefined as any); } catch { /* ignore */ }
    this.info.status = "disconnected";
    await this.markConnected(false);
  }

  /** Fully unlink this WhatsApp session: logs out via WhatsApp's servers
   *  (invalidating the credentials) and closes the local socket. Only call
   *  this for a genuine user-requested disconnect — after this, the business
   *  MUST re-scan a QR code / re-enter a pairing code to reconnect. */
  async destroy(): Promise<void> {
    try { await this.sock?.logout(); } catch { /* ignore */ }
    try { this.sock?.end(undefined as any); } catch { /* ignore */ }
    this.info.status = "disconnected";
    await this.markConnected(false);
  }
}

// ─── Session Store ───────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();

export function getSession(shopId: string): Session | undefined {
  return sessions.get(shopId);
}

export async function createSession(shopId: string, phoneForPairing?: string): Promise<Session> {
  const existing = sessions.get(shopId);
  if (existing) {
    const s = existing.getInfo().status;
    if (s === "connected" || s === "qr" || s === "connecting") return existing;
    await existing.closeSocket().catch(() => {});
    sessions.delete(shopId);
  }

  const session = new Session(shopId, phoneForPairing);
  sessions.set(shopId, session);
  session.connect().catch((e) => console.error("[connect]", e));
  return session;
}

export async function destroySession(shopId: string): Promise<void> {
  const session = sessions.get(shopId);
  if (session) {
    await session.destroy();
    sessions.delete(shopId);
  }
  try {
    const authDir = path.join(SESSIONS_DIR, shopId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

export function getAllSessions(): SessionInfo[] {
  return Array.from(sessions.values()).map((s) => s.getInfo());
}

export async function restoreSessions(): Promise<void> {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const shopId = entry.name;
    // Only restore if there's an actual credentials file — an empty dir means
    // a session that never got past QR/pairing.
    const credsPath = path.join(SESSIONS_DIR, shopId, "creds.json");
    if (!fs.existsSync(credsPath)) continue;
    if (sessions.has(shopId)) continue;

    console.log(`[restore] ${shopId}`);
    try {
      const session = new Session(shopId);
      sessions.set(shopId, session);
      session.connect().catch((e) => console.error(`[restore] ${shopId} connect failed:`, e?.message || e));
      // Stagger restores to avoid connecting many sockets at once.
      await sleep(1500);
    } catch (e: any) {
      console.error(`[restore] ${shopId} failed to create:`, e?.message || e);
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Random delay to mimic human typing behavior and avoid WhatsApp ban detection.
 * Adds randomness to make message timing look more natural.
 */
function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}
