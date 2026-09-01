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

app.listen(PORT, () => {
  console.log(`[bridge-baileys] Running on port ${PORT}`);
  restoreSessions().catch((err) => console.error("[bridge-baileys] restoreSessions failed:", err));
});

// Graceful shutdown — destroy all WhatsApp sessions before exit
const shutdown = async () => {
  console.log("[bridge-baileys] Shutting down...");
  const { getAllSessions: listSessions, getSession } = await import("./lib/sessionManager.js");
  const sessions = listSessions();
  for (const s of sessions) {
    try {
      const session = getSession(s.shopId);
      if (session) await session.destroy();
    } catch { /* ignore */ }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
