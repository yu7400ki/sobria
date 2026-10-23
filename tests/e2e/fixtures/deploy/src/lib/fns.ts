import { defineServerFn } from "rinka/server";

/** title が空でない文字列のときだけ通過する Standard Schema である。 */
const titled = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      const title = (value as { title?: unknown } | null)?.title;
      return typeof title === "string" && title !== ""
        ? { value: { title } }
        : { issues: [{ message: "title is required", path: ["title"] }] };
    },
  },
} as const;

export const ping = defineServerFn(() => "pong");

export const save = defineServerFn({ input: titled })(() => null);
