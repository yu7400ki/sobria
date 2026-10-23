import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import app from "rinka/app";

const server = new Hono();
if (import.meta.main) {
  server.use(serveStatic({ root: fileURLToPath(new URL("../client", import.meta.url)) }));
}
server.use(async (c, next) => {
  await next();
  c.header("x-server-entry", "1");
});
server.get("/health", (c) => c.text("ok"));
server.route("/", app);

if (import.meta.main) serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 3000) });

export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname === "/reject"
      ? Promise.reject(new Error("fetch rejected"))
      : server.fetch(request),
};
