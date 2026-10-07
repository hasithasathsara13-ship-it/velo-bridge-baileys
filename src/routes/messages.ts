import { Router, Request, Response } from "express";
import { getSession, SendBlockedError } from "../lib/sessionManager.js";

export const messageRouter = Router();

/** HTTP callers (dashboard, cron) should not hang waiting in the pacing queue. */
const HTTP_SEND_OPTS = { maxWaitMs: 20_000 } as const;

/**
 * A send refused on purpose (rate cap, opt-out, warm-up…) is a 429 with a
 * machine-readable reason, not a 500, so callers can tell "never retry"
 * (permanent) from "try again later".
 */
function respondSendError(res: Response, err: unknown, label: string, fallback: string) {
  if (err instanceof SendBlockedError) {
    console.warn(`[${label}] blocked: ${err.code} — ${err.message}`);
    return res.status(429).json({
      error: err.message,
      code: err.code,
      permanent: err.permanent,
      retry_after_s: err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : undefined,
    });
  }
  console.error(`[${label}]`, err);
  return res.status(500).json({ error: (err as { message?: string })?.message || fallback });
}

/**
 * POST /message/send-text
 * Body: { shop_id, phone_number, message }
 */
messageRouter.post("/send-text", async (req: Request, res: Response) => {
  const { shop_id, phone_number, message, kind } = req.body as {
    shop_id?: string; phone_number?: string; message?: string; kind?: string;
  };
  if (!shop_id || !phone_number || !message) {
    return res.status(400).json({ error: "Missing shop_id, phone_number, or message" });
  }

  const session = getSession(shop_id);
  if (!session || session.getInfo().status !== "connected") {
    return res.status(404).json({ error: "Session not connected" });
  }

  try {
    // kind=proactive: a follow-up that is not an answer to a customer message
    // (e.g. a reminder). It is queued and sent slowly under stricter rules, so
    // the reply here is 202 "accepted", not "delivered".
    if (kind === "proactive") {
      const queued = await session.queueProactive(phone_number, message);
      return res.status(202).json({ ok: true, queued: true, position: queued.position });
    }
    const result = await session.sendText(phone_number, message, true, HTTP_SEND_OPTS);
    // NOTE: we deliberately do NOT insert into `messages` here.
    // Admin-initiated sends are already persisted by the frontend, so inserting
    // again would show the message twice in the chat interface.
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: unknown) {
    respondSendError(res, err, "message/send-text", "Send failed");
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
    const result = await session.sendImage(phone_number, image_url, caption, true, HTTP_SEND_OPTS);
    // Frontend persists admin-sent media itself — no insert here (avoids duplicates).
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: unknown) {
    respondSendError(res, err, "message/send-image", "Send image failed");
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
    }, true, HTTP_SEND_OPTS);
    // Frontend persists admin-sent voice itself — no insert here (avoids duplicates).
    res.json({ ok: true, id: result.id, wa_message_id: result.id });
  } catch (err: unknown) {
    respondSendError(res, err, "message/send-audio", "Send audio failed");
  }
});

/**
 * POST /message/send-document or /message/send-video
 * Body: { shop_id, phone_number, file_url, mimetype, file_name }
 */
for (const kind of ["document", "video"] as const) {
  messageRouter.post(`/send-${kind}`, async (req: Request, res: Response) => {
    const { shop_id, phone_number, file_url, mimetype, file_name } = req.body as {
      shop_id?: string; phone_number?: string; file_url?: string; mimetype?: string; file_name?: string;
    };
    if (!shop_id || !phone_number || !file_url) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const session = getSession(shop_id);
    if (!session || session.getInfo().status !== "connected") {
      return res.status(404).json({ error: "Session not connected" });
    }
    try {
      const result = await session.sendFile(phone_number, kind, file_url, mimetype || "", file_name || "file", HTTP_SEND_OPTS);
      res.json({ ok: true, id: result.id, wa_message_id: result.id });
    } catch (err: unknown) {
      respondSendError(res, err, `message/send-${kind}`, "Send failed");
    }
  });
}

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
 * GET /message/guard?shop_id=...
 * Anti-ban diagnostics for one number: send counts vs caps, warm-up age and
 * today's proactive quota, circuit-breaker state, opt-outs.
 */
messageRouter.get("/guard", (req: Request, res: Response) => {
  const shopId = String(req.query.shop_id || "");
  if (!shopId) return res.status(400).json({ error: "Missing shop_id" });
  const session = getSession(shopId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true, guard: session.getGuardSnapshot() });
});

messageRouter.get("/contacts", (req: Request, res: Response) => {
  const shopId = String(req.query.shop_id || "");
  if (!shopId) return res.status(400).json({ error: "Missing shop_id" });
  const session = getSession(shopId);
  if (!session) return res.status(404).json({ error: "Session not connected" });
  res.json({ ok: true, contacts: session.listPushNames() });
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
