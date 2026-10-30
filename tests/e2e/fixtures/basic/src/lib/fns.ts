import { defineServerFn } from "sobria/server";

export const ping = defineServerFn(() => "pong");

export const save = defineServerFn(() => null);
