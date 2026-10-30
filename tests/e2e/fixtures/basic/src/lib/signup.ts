import { defineServerFn, redirect } from "sobria/server";

export const signup = defineServerFn({
  input: (value: { name?: unknown }) => ({
    name: typeof value?.name === "string" ? value.name : "",
  }),
})((_c, { input }) => {
  if (input.name === "admin") return { error: "この名前は使用されています", values: input };
  throw redirect("/signup?done=1");
});
