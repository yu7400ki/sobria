import { defineServerFn } from "rinka/server";

/** 保存したノートの名前である。 */
export const notes: string[] = [];

export const addNote = defineServerFn(() => {
  notes.push(`note ${notes.length + 1}`);
});

export const failNote = defineServerFn(() => {
  throw new Error("note failed");
});
