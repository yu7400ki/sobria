import { defineServerFn } from "rinka/server";

export const ping = defineServerFn(() => "pong");

export const save = defineServerFn(() => null);
