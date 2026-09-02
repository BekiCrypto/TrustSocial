import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { buildDashboard } from "./web/dashboard.js";
import { startScheduler } from "./scheduler.js";
import "./db.js"; // side-effect: opens the db and runs the schema

const app = express();

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
app.listen(port, () => {
  console.log(`TrustSocial listening on :${port}`);
  console.log(`Public URL configured as: ${process.env.PUBLIC_URL ?? "(not set - OAuth callbacks will fail)"}`);
  console.log(`TrustLotto repo root: ${trustlottoRepoRoot}`);
});

const stopScheduler = startScheduler();
process.on("SIGTERM", () => {
  stopScheduler();
  process.exit(0);
});
