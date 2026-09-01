import { Router, Request, Response } from "express";
import { createSession, destroySession, getSession, getAllSessions } from "../lib/sessionManager.js";

export const sessionRouter = Router();

/**
 * POST /session/create
 * Body: { shop_id: string, phone_number?: string }
 * If phone_number is provided, uses phone pairing (linking code) instead of QR.
 */
sessionRouter.post("/create", async (req: Request, res: Response) => {
  const { shop_id, phone_number } = req.body as { shop_id?: string; phone_number?: string };
  if (!shop_id) return res.status(400).json({ error: "Missing shop_id" });
  try {
    const session = await createSession(shop_id, phone_number);
    res.json(session.getInfo());
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to create session" });
  }
});

/**
 * GET /session/:shopId/status
 */
sessionRouter.get("/:shopId/status", (req: Request, res: Response) => {
  const session = getSession(String(req.params.shopId));
  if (!session) return res.json({ status: "disconnected", qrCode: null, pairingCode: null });
  res.json(session.getInfo());
});

/**
 * DELETE /session/:shopId
 */
sessionRouter.delete("/:shopId", async (req: Request, res: Response) => {
  try {
    await destroySession(String(req.params.shopId));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /session/all
 */
sessionRouter.get("/all", (_req: Request, res: Response) => {
  res.json({ sessions: getAllSessions() });
});
