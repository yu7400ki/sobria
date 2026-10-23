import { defineMiddleware } from "rinka/server";

export default defineMiddleware(async (c, next) => {
  c.header("x-root", "1");
  await next();
});
