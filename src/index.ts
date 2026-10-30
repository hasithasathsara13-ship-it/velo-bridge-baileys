import "dotenv/config";
import express from "express";
import * as fs from "fs";
import * as path from "path";
import { sessionRouter } from "./routes/session.js";
import { messageRouter } from "./routes/messages.js";
import { authMiddleware } from "./middleware/auth.js";
import { restoreSessions, getAllSessions } from "./lib/sessionManager.js";

process.on("uncaughtException", (err) => console.error("[bridge] Uncaught:", err.message));
process.on("unhandledRejection", (err) => console.error("[bridge] Unhandled:", err));

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(express.json({ limit: "10mb" }));

// Health check (no auth) — includes engine + session summary for the Updates page.
app.get("/health", (_req, res) => {
  const sessions = getAllSessions();
  res.json({
    ok: true,
    engine: "baileys",
    uptime: process.uptime(),
    sessionCount: sessions.length,
    connectedCount: sessions.filter((s) => s.status === "connected").length,
  });
});

// Protected routes
app.use(authMiddleware);
app.use("/session", sessionRouter);
app.use("/message", messageRouter);

// 24/7 Follow-Up Cron Trigger: ping Vercel checkout-reminder endpoint every hour
function startFollowUpScheduler() {
  const frontendUrl = (process.env.FRONTEND_URL || "https://veloai.pro").replace(/\/+$/, "");
  const cronSecret = process.env.CRON_SECRET || "123";
  const intervalMs = Number(process.env.FOLLOWUP_CRON_INTERVAL_MS) || 60 * 60 * 1000; // 1 hour

  const triggerCron = async () => {
    try {
      console.log(`[bridge-baileys] ⏰ Triggering follow-up reminder cron at ${frontendUrl}...`);
      const res = await fetch(`${frontendUrl}/api/cron/checkout-reminder?key=${cronSecret}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(60_000),
      });
      console.log(`[bridge-baileys] ⏰ Follow-up cron response: ${res.status} ${res.statusText}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bridge-baileys] ⏰ Follow-up cron trigger failed:`, msg);
    }
  };

  // Initial trigger after 2 minutes (so bridge sessions have time to connect first)
  setTimeout(() => {
    void triggerCron();
    setInterval(triggerCron, intervalMs);
  }, 120_000);
}

app.listen(PORT, () => {
  console.log(`[bridge-baileys] Running on port ${PORT} (baileys-v7-phone-resend)`);
  restoreSessions().catch((err) => console.error("[bridge-baileys] restoreSessions failed:", err));
  startFollowUpScheduler();
});

// Graceful shutdown — destroy all WhatsApp sessions before exit
const shutdown = async () => {
  console.log("[bridge-baileys] Shutting down...");
  const { getAllSessions: listSessions, getSession } = await import("./lib/sessionManager.js");
  const sessions = listSessions();
  for (const s of sessions) {
    try {
      const session = getSession(s.shopId);
      if (session) await session.closeSocket();
    } catch { /* ignore */ }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
