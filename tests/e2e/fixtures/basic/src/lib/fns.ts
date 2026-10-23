import { defineServerFn } from "rinka/server";

export const ping = defineServerFn(() => "pong");
