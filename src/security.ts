import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Hand-rolled security middleware - no `helmet`, no `express-rate-limit`, no `csurf`.
 * Every one of these is a well-understood, small primitive; pulling in a dependency
 * for each would work against the one thing this project is actually selling itself
 * on (see the README/landing page: "genuinely tiny"). Keep this file short and boring.
 */

// ---------------------------------------------------------------- security headers
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Only meaningful over HTTPS - harmless to send over plain HTTP dev, so no branching needed.
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:", // local assets + a remote already-public image URL (see MediaRef)
      "media-src 'self' https:", // local /media/:file + a remote already-public video URL
      "style-src 'self'",
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ")
  );
  next();
}

// ---------------------------------------------------------------- rate limiting (in-memory, per-IP)
interface Bucket {
  count: number;
  resetAt: number;
}

/** A fresh limiter instance per call - each protected route should get its own bucket map. */
export function rateLimiter(opts: { windowMs: number; max: number; message: string }) {
  const buckets = new Map<string, Bucket>();
  // Sweep expired buckets periodically so long-uptime + many distinct IPs (scanners)
  // doesn't grow this map forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  }, 10 * 60_000);
  sweep.unref?.();

  return function limit(req: Request, res: Response, next: NextFunction) {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).send(opts.message);
    }
    next();
  };
}

// ---------------------------------------------------------------- CSRF (session-bound synchronizer token)
// Not a cookie-based double-submit scheme - the token is generated server-side, tied to the
// session token, and only ever revealed inside a page that already required a valid session
// cookie to render. A cross-site form can't read it to forge a request.
const csrfBySession = new Map<string, string>();

export function getOrCreateCsrfToken(sessionToken: string): string {
  let token = csrfBySession.get(sessionToken);
  if (!token) {
    token = randomBytes(24).toString("hex");
    csrfBySession.set(sessionToken, token);
  }
  return token;
}

export function clearCsrfToken(sessionToken: string): void {
  csrfBySession.delete(sessionToken);
}

export function verifyCsrfToken(sessionToken: string | undefined, submitted: unknown): boolean {
  if (!sessionToken || typeof submitted !== "string" || !submitted) return false;
  const expected = csrfBySession.get(sessionToken);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(submitted);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${token}">`;
}
