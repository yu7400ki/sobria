import { defineServerFn } from "sobria/server";

export const letters = defineServerFn({ method: "GET" })(async function* () {
  yield "a";
  await new Promise((resolve) => setTimeout(resolve, 10));
  yield "b";
  yield "c";
});
