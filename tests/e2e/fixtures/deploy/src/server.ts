import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "rinka/app";

const server = new Hono();
if (import.meta.main) {
  server.use(serveStatic({ root: fileURLToPath(new URL("../client", import.meta.url)) }));
}
server.get("/health", (c) => c.text("ok"));
server.route("/", app);

if (import.meta.main) serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 3000) });

export default server;
