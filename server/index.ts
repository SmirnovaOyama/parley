import { readFileSync } from "node:fs";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { Agent, setGlobalDispatcher } from "undici";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "./auth.ts";
import { clearStaleUploads } from "./attachments.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { chatRoutes } from "./routes/chat.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { sharedRoutes } from "./routes/shared.ts";
import { adminToolRoutes } from "./routes/admin-tools.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { meRoutes } from "./routes/me.ts";
import { personaRoutes } from "./routes/personas.ts";
import { projectRoutes } from "./routes/projects.ts";
import { PREVIEW_SHELL, previewHeaders } from "./preview.ts";
import { enforceRetention } from "./retention.ts";
import { clearExpiredSessions } from "./sessions.ts";
import { clearStaleSignupCodes } from "./signup-codes.ts";

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

// For the Docker HEALTHCHECK and uptime monitors: up when the server answers and the database reads.
app.get("/api/health", (c) => {
  try {
    db.prepare("SELECT 1").get();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

// A body left unread, because the answer came before it had all arrived (one too big, say), is
// read and thrown away, so the connection can carry the client's next request. @hono/node-server
// means to do this itself, but once the body has started to be read, the stream it was read
// through holds it paused. Then the clean-up stalls and cuts the connection off half a second
// later, when the client may already have sent its next request down it.
app.use("/api/*", async (c, next) => {
  await next();
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  if (incoming && !incoming.readableEnded) incoming.removeAllListeners("data").resume();
});

// A request's body is read whole, so a JSON one is held to 1 MB (the longest message is a few
// hundred KB of it), before anyone has signed in. Files go up as raw bytes to their own routes,
// which set their own limits once they know who's sending.
const MAX_JSON_BYTES = 1024 * 1024;
const RAW_UPLOAD = /^\/api\/(uploads|import|knowledge\/[^/]+\/docs)$/;
const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: (c) => c.json({ error: "That request is too big" }, 413) });
app.use("/api/*", (c, next) => (c.req.method === "PUT" && RAW_UPLOAD.test(c.req.path) ? next() : jsonLimit(c, next)));
app.use("/api/*", sameOriginGuard, sessionMiddleware);
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/admin", adminToolRoutes);
// Shared chat links, readable without an account when the site allows it (before the signed-in routes).
app.route("/api/shared", sharedRoutes);
// People's own accounts on MCP servers. Its sign-in callback answers without an account too (with
// a way to the sign-in page), so it goes before the routes that turn those away.
app.route("/api", connectionRoutes);
app.route("/api", projectRoutes);
app.route("/api", knowledgeRoutes);
app.route("/api", meRoutes);
app.route("/api", personaRoutes);
app.route("/api", chatRoutes);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// What a phone or browser needs to add the site to a home screen or install it as an app, under
// the site's own name (set at run time, like the page's). The icons are in public/; their sources
// are design/app-icon*.svg.
app.get("/manifest.webmanifest", (c) => {
  const icon = (src: string, size: number, purpose?: string) => ({ src, sizes: `${size}x${size}`, type: "image/png", ...(purpose ? { purpose } : {}) });
  c.header("Cache-Control", "no-cache");
  return c.body(
    JSON.stringify({
      id: "/",
      name: env.appName,
      short_name: env.appName,
      description: "Chat with AI models",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [icon("/icon-192.png", 192), icon("/icon-512.png", 512), icon("/icon-maskable-512.png", 512, "maskable")],
      shortcuts: [{ name: "New chat", url: "/chat", icons: [icon("/icon-192.png", 192)] }],
    }),
    200,
    { "Content-Type": "application/manifest+json; charset=utf-8" },
  );
});

// In production the API also serves the built app; any other path falls back to index.html. The
// page gets the site's name here, at run time, so one built image serves any name.
if (env.isProd) {
  const name = env.appName.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const page = readFileSync("./dist/index.html", "utf8")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`)
    .replace("</head>", () => `  <meta name="application-name" content="${name}" />\n    <meta name="apple-mobile-web-app-title" content="${name}" />\n  </head>`);
  const sendPage = (c: Context) => c.html(page);
  app.get("/", sendPage);
  app.get("/index.html", sendPage);
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", sendPage);
}

// Files added to a message that was never sent are cleared after a day, chats past the site's
// retention rules are deleted, sign-ins that ran out are forgotten with where they were used, and
// sign-up codes past their day go; all checked every hour.
clearStaleUploads();
enforceRetention();
clearExpiredSessions();
clearStaleSignupCodes();
setInterval(() => {
  clearStaleUploads();
  enforceRetention();
  clearExpiredSessions();
  clearStaleSignupCodes();
}, 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
