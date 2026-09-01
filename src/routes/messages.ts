import { Router, Request, Response } from "express";
import { getSession } from "../lib/sessionManager.js";

export const messageRouter = Router();

/**
 * POST /message/send-text
 * Body: { shop_id, phone_number, message }
 */
messageRouter.post("/send-text", async (req: Request, res: Response) => {
  const { shop_id, phone_number, message } = req.body as {
    shop_id?: string; phone_number?: string; message?: string;
  };
  if (!shop_id || !phone_number || !message) {
    return res.status(400).json({ error: "Missing shop_id, phone_number, or message" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    const result = await session.sendText(phone_number, message);
    // NOTE: we deliberately do NOT insert into `messages` here.
    // Admin-initiated sends are already persisted by the frontend, so inserting
    // again would show the message twice in the chat interface.
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: any) {
    console.error("[message/send-text]", err);
    res.status(500).json({ error: err.message || "Send failed" });
  }
});

/**
 * POST /message/send-image
 * Body: { shop_id, phone_number, image_url, caption }
 */
messageRouter.post("/send-image", async (req: Request, res: Response) => {
  const { shop_id, phone_number, image_url, caption } = req.body as {
    shop_id?: string; phone_number?: string; image_url?: string; caption?: string;
  };
  if (!shop_id || !phone_number || !image_url) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    const result = await session.sendImage(phone_number, image_url, caption);
    // Frontend persists admin-sent media itself — no insert here (avoids duplicates).
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: any) {
    console.error("[message/send-image]", err);
    res.status(500).json({ error: err.message || "Send image failed" });
  }
});

/**
 * POST /message/send-audio
 * Body: { shop_id, phone_number, audio_url, audio_base64?, mimetype? }
 * Sends a voice note. Prefers audio_url; falls back to base64 bytes.
 */
messageRouter.post("/send-audio", async (req: Request, res: Response) => {
  const { shop_id, phone_number, audio_url, audio_base64, mimetype } = req.body as {
    shop_id?: string; phone_number?: string; audio_url?: string;
    audio_base64?: string; mimetype?: string;
  };
  if (!shop_id || !phone_number || (!audio_url && !audio_base64)) {
    return res.status(400).json({ error: "Missing shop_id, phone_number, or audio data" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    const result = await session.sendAudio(phone_number, {
      url: audio_url,
      base64: audio_base64,
      mimetype: mimetype || "audio/ogg; codecs=opus",
    });
    // Frontend persists admin-sent voice itself — no insert here (avoids duplicates).
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: any) {
    console.error("[message/send-audio]", err);
    res.status(500).json({ error: err.message || "Send audio failed" });
  }
});

/**
 * POST /message/edit
 * Body: { shop_id, phone_number, wa_message_id, new_text }
 */
messageRouter.post("/edit", async (req: Request, res: Response) => {
  const { shop_id, phone_number, wa_message_id, new_text } = req.body as {
    shop_id?: string; phone_number?: string; wa_message_id?: string; new_text?: string;
  };
  if (!shop_id || !phone_number || !wa_message_id || !new_text) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    await session.editMessage(wa_message_id, phone_number, new_text);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[message/edit]", err);
    res.status(500).json({ error: err.message || "Edit failed" });
  }
});

/**
 * POST /message/delete
 * Body: { shop_id, phone_number, wa_message_id }
 */
messageRouter.post("/delete", async (req: Request, res: Response) => {
  const { shop_id, phone_number, wa_message_id } = req.body as {
    shop_id?: string; phone_number?: string; wa_message_id?: string;
  };
  if (!shop_id || !phone_number || !wa_message_id) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    await session.deleteMessage(wa_message_id, phone_number);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[message/delete]", err);
    res.status(500).json({ error: err.message || "Delete failed" });
  }
});
