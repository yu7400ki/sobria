import type { Context } from "hono";

export const GET = (c: Context) => ({ id: c.req.param("id") });

export const DELETE = () => undefined;
