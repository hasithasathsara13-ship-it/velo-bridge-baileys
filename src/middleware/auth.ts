import { Request, Response, NextFunction } from "express";

/**
 * Auth middleware.
 * The frontend proxy (/api/wa-bridge) sends `x-bridge-secret` header
 * matching BRIDGE_SECRET env var.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.BRIDGE_SECRET?.trim();
  if (!secret) {
    // If no secret is configured, allow all requests (dev mode)
    next();
    return;
  }

  const provided = req.headers["x-bridge-secret"] as string | undefined;
  if (provided === secret) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
