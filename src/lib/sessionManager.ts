import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
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

  constructor(shopId: string, phoneForPairing?: string) {
    this.info = { shopId, status: "connecting", qrCode: null, pairingCode: null, phoneNumber: null };
    this.pairingPhone = phoneForPairing?.replace(/[^\d]/g, "") || null;
    this.authDir = path.join(SESSIONS_DIR, shopId);
    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
  }

  getInfo(): SessionInfo {
    return { ...this.info };
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  async connect(): Promise<void> {
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
        this.handleIncoming(msg).catch((e) => console.error("[msg]", e));
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

  private async handleIncoming(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid || "";
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || msg.key.fromMe) return;

    const msgId = msg.key.id || "";
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return;
      this.processedMsgIds.add(msgId);
      if (this.processedMsgIds.size > 1000) this.processedMsgIds.clear();
    }

    const content = msg.message;
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
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        bubbles?: string[];
        images?: string[];
        reviews_link?: string;
      };

      if (!res.ok || !data?.ok) return;

      for (const url of (data.images || []).slice(0, 6)) {
        try {
          await this.sendImage(phone, url);
          await sleep(1200);
        } catch { /* ignore */ }
      }

      for (const b of data.bubbles || []) {
        if (!b.trim()) continue;
        try {
          await this.sendText(phone, b);
          await sleep(900);
        } catch { /* ignore */ }
      }

      if (data.reviews_link) {
        try { await this.sendText(phone, `⭐ More reviews: ${data.reviews_link}`); } catch { /* ignore */ }
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

  async sendText(phone: string, message: string): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    const sent = await this.sock.sendMessage(jid, { text: message });
    return { id: sent?.key?.id || "" };
  }

  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);
    try {
      // Fetch the bytes ourselves — more reliable than letting Baileys fetch a
      // remote URL, which can fail silently on redirects/slow responses.
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`Failed to fetch image_url: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const sent = await this.sock.sendMessage(jid, { image: buffer, caption: caption || undefined });
      return { id: sent?.key?.id || "" };
    } catch (err) {
      console.error(`[session ${this.info.shopId}] sendImage fetch failed, falling back to url mode:`, err);
      const sent = await this.sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || undefined });
      return { id: sent?.key?.id || "" };
    }
  }

  async sendAudio(
    phone: string,
    audio: { url?: string; base64?: string; mimetype?: string },
  ): Promise<{ id: string }> {
    if (!this.sock) throw new Error("Session not connected");
    const jid = this.toJid(phone);

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

    const sent = await this.sock.sendMessage(jid, {
      audio: buffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
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
    await existing.destroy().catch(() => {});
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
