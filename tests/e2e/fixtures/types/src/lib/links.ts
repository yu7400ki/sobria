import { href } from "sobria/router";

export const userLink = href("/users/[id]", { id: "1" });

// @ts-expect-error 存在しないルートは型エラーになる
export const missingLink = href("/missing");
