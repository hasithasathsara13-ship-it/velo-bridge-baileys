import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type WASocket,
  type WAMessage,
  type ConnectionState,
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

  constructor(shopId: string, phoneForPairing?: string) {
    this.info = { shopId, status: "connecting", qrCode: null, pairingCode: null, phoneNumber: null };
    this.pairingPhone = phoneForPairing?.replace(/[^\d]/g, "") || null;
    this.authDir = path.join(SESSIONS_DIR, shopId);
    this.lidMapPath = path.join(this.authDir, "lid-map.json");
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

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.saveCreds = saveCreds;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => this.onConnectionUpdate(update));
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) {
          if (this.isBridgeInitiated(msg)) continue;
          this.handleOwnerSentMessage(msg).catch((e) => console.error("[msg-owner]", e));
          continue;
        }
        this.handleIncoming(msg).catch((e) => console.error("[msg]", e));
      }
    });

    // Contact syncs are the richest source of lid<->phone pairs: Baileys'
    // Contact carries both `lid` and `jid` for privacy-mode contacts.
    const onContacts = (contacts: Array<{ id?: string; lid?: string; jid?: string }>) => {
      for (const c of contacts || []) {
        const phoneJid = c.jid || (c.id && !c.id.includes("@lid") ? c.id : "");
        const lidJid = c.lid || (c.id && c.id.includes("@lid") ? c.id : "");
        const phone = jidUserDigits(phoneJid);
        if (lidJid && phone) this.rememberLid(lidJid, phone);
      }
    };
    sock.ev.on("contacts.upsert", onContacts);
    sock.ev.on("contacts.update", onContacts as any);

    // Emitted when a contact shares their phone number for a LID chat.
    sock.ev.on("chats.phoneNumberShare" as any, (update: { lid?: string; jid?: string }) => {
      const phone = jidUserDigits(update?.jid);
      if (update?.lid && phone) this.rememberLid(update.lid, phone);
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
        const jid = this.sock?.user?.id || "";
        this.info.phoneNumber = jid.split(":")[0].split("@")[0].replace(/\D/g, "") || null;
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

  // ─── Bridge-send tracking ────────────────────────────────────────────────

  private async trackBridgeSend<T extends { key?: { id?: string | null } } | null | undefined>(
    jid: string,
    fn: () => Promise<T>
  ): Promise<T> {
    this.pendingBridgeSends.set(jid, (this.pendingBridgeSends.get(jid) || 0) + 1);
    try {
      const result = await fn();
      const id = result?.key?.id || "";
      if (id) {
        this.bridgeSentMessageIds.add(id);
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
    // Privacy-mode contacts show up as <lid>@lid instead of <phone>@s.whatsapp.net.
    // Baileys attaches the real phone-number jid as senderPn/participantPn on the
    // message key in that case — prefer it so the dashboard/bot show the actual
    // number, not the internal LID.
    const pn = msg.key.senderPn || msg.key.participantPn || "";
    if (pn) return pn.split("@")[0].replace(/\D/g, "");
    return jid.split("@")[0].replace(/\D/g, "");
  }

  /** Resolve the customer's real phone number for an owner-sent (fromMe)
   *  message. WhatsApp never attaches a recipient's phone number to an
   *  outbound stanza, so for privacy-mode contacts the jid is a @lid and we
   *  must map it back ourselves. */
  private async resolveOwnerCounterpartyNumber(msg: WAMessage): Promise<string> {
    const jid = msg.key.remoteJid || "";

    // Non-LID chats already carry the real number in the jid.
    if (!jid.includes("@lid")) return this.resolveRealNumber(msg);

    const lid = jidUserDigits(jid);

    // 1. Known mapping (from prior inbound messages / contacts / disk).
    const known = this.lidToPhone.get(lid);
    if (known) return known;

    // 2. Ask WhatsApp: usync returns { jid, exists, lid } per phone, so we can
    //    reverse-match this LID against the phone numbers we already know for
    //    this shop. Self-healing after a restart with an empty/partial map.
    const resolved = await this.resolveLidViaUsync(lid).catch(() => "");
    if (resolved) return resolved;

    console.warn(`[session ${this.info.shopId}] could not map lid ${lid} to a phone number; falling back to lid digits`);
    return this.resolveRealNumber(msg);
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
        .filter((p) => p.length >= 6 && !this.mappedPhones.has(p));
      if (phones.length === 0) return "";

      // Query in modest batches so one huge usync call can't stall the socket.
      for (let i = 0; i < phones.length; i += 25) {
        const batch = phones.slice(i, i + 25);
        const results = (await (this.sock as any).onWhatsApp(
          ...batch.map((p) => `${p}@s.whatsapp.net`),
        )) as Array<{ jid?: string; lid?: string; exists?: boolean }> | undefined;

        for (const r of results || []) {
          const phone = jidUserDigits(r?.jid);
          const rLid = jidUserDigits(r?.lid);
          if (rLid && phone) this.rememberLid(rLid, phone);
        }

        const hit = this.lidToPhone.get(lid);
        if (hit) return hit;
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
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 1000) this.processedMsgIds.clear();
    }

    // Unwrap envelope types (documentWithCaptionMessage, viewOnceMessage,
    // ephemeralMessage, editedMessage, …) so the real content (e.g. the
    // actual documentMessage) is what we check below. Without this, a PDF
    // sent normally from the WhatsApp app arrives wrapped in
    // documentWithCaptionMessage and is silently dropped as an empty text
    // message.
    const content = normalizeMessageContent(msg.message);
    if (!content) return;

    const type = Object.keys(content)[0] || "";
    console.log(`[msg] incoming: type=${type}, from=${jid.slice(0, 20)}`);

    const sb = getSupabase();
    const shopId = this.info.shopId;
    const phone = this.resolveRealNumber(msg);
    if (!phone) return;

    // Remember which exact jid this phone number messaged from, so replies
    // (especially to @lid contacts) go back to the correct chat.
    this.phoneToChatJid.set(phone, jid);
    // Record every LID form WhatsApp gave us for this contact so a later
    // owner-sent (fromMe) message addressed via @lid resolves back to this phone.
    this.rememberLid(msg.key.senderLid, phone);
    this.rememberLid(msg.key.participantLid, phone);
    if (jid.includes("@lid")) this.rememberLid(jid, phone);

    let textContent = "";
    let mediaUrl: string | null = null;
    let mediaType: "audio" | "image" | "document" | null = null;
    let caption = "";

    const isMedia = Boolean(content.imageMessage || content.audioMessage || content.videoMessage || content.documentMessage);

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
    if (textForBot || mediaType) {
      await this.triggerBot(shopId, phone, textForBot, mediaType, mediaUrl).catch((e) => console.error("[bot]", e));
    }
  }

  // ─── Owner-Sent Message Handler (manual sends from the paired phone) ────

  private async handleOwnerSentMessage(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid || "";
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

    const msgId = msg.key.id || "";
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 1000) this.processedMsgIds.clear();
    }

    const content = normalizeMessageContent(msg.message);
    if (!content) return;

    const type = Object.keys(content)[0] || "";
    console.log(`[msg] owner-sent (manual): type=${type}, jid=${jid.slice(0, 20)}`);
    console.log(`[msg] owner-sent key: remoteJid=${jid}, senderLid=${msg.key.senderLid || "-"}, senderPn=${msg.key.senderPn || "-"}, participantLid=${msg.key.participantLid || "-"}, participantPn=${msg.key.participantPn || "-"}`);

    const sb = getSupabase();
    const shopId = this.info.shopId;
    const phone = await this.resolveOwnerCounterpartyNumber(msg);
    if (!phone) return;

    this.phoneToChatJid.set(phone, jid);
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

  private async triggerBot(shopId: string, phone: string, text: string, mediaType: "audio" | "image" | "document" | null, mediaUrl: string | null): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL?.trim();
    const bridgeSecret = process.env.BRIDGE_SECRET?.trim() || "";
    if (!frontendUrl) return;

    try {
      const payload: Record<string, string> = { shop_id: shopId, phone_number: phone, text };
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
        } catch { /* ignore */ }
      }

      // Send audio with random delays (typing indicator shown automatically)
      for (const url of (data.audios || []).slice(0, 2)) {
        try {
          await this.sendAudio(phone, { url }); // Typing indicator built-in
          await randomDelay(1000, 2000); // Random 1-2 seconds between audio
        } catch { /* ignore */ }
      }

      // Send text bubbles with typing indicators and random delays
      for (const b of data.bubbles || []) {
        if (!b.trim()) continue;
        try {
          await this.sendText(phone, b); // Typing indicator built-in (based on message length)
          await randomDelay(800, 1500); // Random pause between messages
        } catch { /* ignore */ }
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
    if (remembered) return remembered;
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
