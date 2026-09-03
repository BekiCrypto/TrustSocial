import "dotenv/config";
import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboard } from "./web/dashboard.js";
import { startScheduler } from "./scheduler.js";
import { securityHeaders } from "./security.js";
import { db } from "./db.js"; // also runs the schema as a side effect of importing it

// ---------------------------------------------------------------- fail fast on obvious misconfiguration
// A self-hosted tool that silently runs half-broken is worse than one that refuses to start -
// these are exactly the mistakes someone cloning this for the first time is likely to make.
function checkEnv() {
  const problems: string[] = [];
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || key.length !== 64 || !/^[0-9a-f]+$/i.test(key)) {
    problems.push(
      "TOKEN_ENCRYPTION_KEY is missing or not a 64-char hex string - connecting any account will fail. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (!process.env.DASHBOARD_PASSWORD) {
    problems.push("DASHBOARD_PASSWORD is not set - nobody will be able to log in (this is safe, just useless).");
  }
  if (!process.env.PUBLIC_URL) {
    problems.push("PUBLIC_URL is not set - OAuth callback URLs and media links will be built wrong.");
  } else if (process.env.PUBLIC_URL.startsWith("http://") && !process.env.PUBLIC_URL.includes("localhost")) {
    problems.push(`PUBLIC_URL (${process.env.PUBLIC_URL}) is http:// but isn't localhost - OAuth requires https:// for a real deployment.`);
  }
  if (problems.length) {
    console.warn("⚠ TrustSocial started with configuration problems:");
    for (const p of problems) console.warn(`  - ${p}`);
  }
}
checkEnv();

const app = express();
app.set("trust proxy", 1); // one hop: the reverse proxy in front of this container (Caddy/nginx/etc) - needed for correct req.ip / rate limiting
app.use(securityHeaders);

// `public/` sits next to `src/` (dev, via tsx) and next to `dist/` (prod build) alike -
// one level up from this file's own directory, either way.
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(
  express.static(publicDir, {
    maxAge: "1h",
    // `public/auth/tiktok/callback/` holds a platform domain-verification file, which puts a
    // real directory on disk at the exact path the dynamic GET /auth/:platform/callback route
    // also matches. serve-static's default behavior 301-redirects a bare directory request to
    // its own path + "/" before the dashboard router ever sees it - harmless in principle (the
    // redirect preserves the query string, and Express's non-strict routing still matches the
    // trailing-slash retry), but it's an unforced extra hop on a security-sensitive OAuth
    // callback and not worth the fragility. Disabling it only stops that directory-index-style
    // redirect; serving an exact file path (which is all the verification file needs) is
    // unaffected either way.
    redirect: false,
  })
);

// Where the TrustLotto repo checkout lives, so the importer can find
// marketing/social/queue/ and resolve `media:` paths. Override with
// TRUSTLOTTO_REPO_ROOT in .env if this service runs somewhere other than
// right next to that checkout.
const trustlottoRepoRoot = process.env.TRUSTLOTTO_REPO_ROOT
  ? resolve(process.env.TRUSTLOTTO_REPO_ROOT)
  : resolve(process.cwd(), "..", "TrustDraw-Master_DEX");

app.use(
  buildDashboard({
    trustlottoRepoRoot,
    mediaRoots: [resolve(trustlottoRepoRoot, "marketing/social/video/out")],
  })
);

const port = Number(process.env.PORT ?? 4400);
const server = app.listen(port, () => {
  console.log(`TrustSocial listening on :${port}`);
  console.log(`Public URL configured as: ${process.env.PUBLIC_URL ?? "(not set - OAuth callbacks will fail)"}`);
  console.log(`TrustLotto repo root: ${trustlottoRepoRoot}`);
});

const stopScheduler = startScheduler();

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Don't hang forever waiting for in-flight requests to drain.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
