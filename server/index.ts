import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { Agent, setGlobalDispatcher } from "undici";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "./auth.ts";
import { clearStaleUploads } from "./attachments.ts";
import { env } from "./env.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { chatRoutes } from "./routes/chat.ts";
import { sharedRoutes } from "./routes/shared.ts";
import { adminToolRoutes } from "./routes/admin-tools.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { meRoutes } from "./routes/me.ts";
import { personaRoutes } from "./routes/personas.ts";
import { projectRoutes } from "./routes/projects.ts";
import { PREVIEW_SHELL, previewHeaders } from "./preview.ts";
import { enforceRetention } from "./retention.ts";

// Node gives up opening a connection after 10 seconds. Behind a slow proxy (common when reaching
// the AI providers from some regions) the TLS handshake alone can take longer, so wait a minute.
setGlobalDispatcher(new Agent({ connect: { timeout: 60_000 } }));

const app = new Hono<AppEnv>();

const siteHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
});
// Files a reply made are sent fully sandboxed: whatever is in them can't run as this site, even
// when opened directly.
const fileHeaders = secureHeaders({
  contentSecurityPolicy: { sandbox: [], defaultSrc: ["'none'"], imgSrc: ["'self'"], styleSrc: ["'unsafe-inline'"] },
});
const FILE_PATH = /^\/api\/(files|shared\/[^/]+\/files|knowledge\/[^/]+\/docs)\//;
// The page that runs code from a reply sets its own, sandboxed headers (server/preview.ts).
const PREVIEW_PATH = "/api/preview";
app.use("*", (c, next) =>
  c.req.path === PREVIEW_PATH ? previewHeaders(c, next) : FILE_PATH.test(c.req.path) ? fileHeaders(c, next) : siteHeaders(c, next),
);
app.get(PREVIEW_PATH, (c) => c.html(PREVIEW_SHELL));

app.use("/api/*", sameOriginGuard, sessionMiddleware);
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/admin", adminToolRoutes);
// Shared chat links, readable without an account when the site allows it (before the signed-in routes).
app.route("/api/shared", sharedRoutes);
app.route("/api", projectRoutes);
app.route("/api", knowledgeRoutes);
app.route("/api", meRoutes);
app.route("/api", personaRoutes);
app.route("/api", chatRoutes);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// In production the API also serves the built app; any other path falls back to index.html. The
// page gets the site's name here, at run time, so one built image serves any name.
if (env.isProd) {
  const name = env.appName.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const page = readFileSync("./dist/index.html", "utf8")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`)
    .replace("</head>", () => `  <meta name="application-name" content="${name}" />\n  </head>`);
  const sendPage = (c: Context) => c.html(page);
  app.get("/", sendPage);
  app.get("/index.html", sendPage);
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", sendPage);
}

// Files added to a message that was never sent are cleared after a day, and chats past the site's
// retention rules are deleted; both checked every hour.
clearStaleUploads();
enforceRetention();
setInterval(() => {
  clearStaleUploads();
  enforceRetention();
}, 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
