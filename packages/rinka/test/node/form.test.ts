import type { StandardSchema } from "hono/factory";
import { describe, expect, it, vi } from "vitest";

import { redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/render.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { rpcPath } from "../../src/shared/wire.ts";

let count = 0;

/** `fn` を一意な ID で登録し、ID と登録した関数を返す。 */
function register<F extends Parameters<typeof registerServerFn>[1]>(fn: F): { id: string; fn: F } {
  const id = `src/forms-${++count}.ts#fn`;
  return { id, fn: registerServerFn(id, fn) };
}

/** ID が `id` のサーバー関数に、`body` をフォームとして送信したレスポンスを返す。 */
function submit(
  id: string,
  body: FormData | URLSearchParams,
  headers: Record<string, string> = {},
) {
  return createApp([]).fetch(
    new Request(`http://localhost${rpcPath(id)}`, { method: "POST", body, headers }),
  );
}

const title: StandardSchema<{ title: string }> = {
  "~standard": {
    validate: (value: unknown) =>
      typeof value === "object" && value !== null && "title" in value && value.title !== ""
        ? { value: value as { title: string } }
        : { issues: [{ message: "題名を入力してください", path: ["title"] }] },
  },
};

describe("form の action に渡したサーバー関数", () => {
  it("action をエンドポイントの URL に、method を post に、enctype を multipart/form-data にする", async () => {
    const { id, fn } = register(defineServerFn(() => null));
    const html = await renderToString(jsx("form", { action: fn, children: "x" }));
    expect(html).toBe(
      `<form action="${rpcPath(id)}" method="post" enctype="multipart/form-data">x</form>`,
    );
  });

  it("enctype を記述していれば、その値を使用する", async () => {
    const { fn } = register(defineServerFn(() => null));
    const html = await renderToString(
      jsx("form", { action: fn, enctype: "application/x-www-form-urlencoded" }),
    );
    expect(html).toContain('enctype="application/x-www-form-urlencoded"');
  });
});

describe("JS が無いときのフォームの送信", () => {
  it("FormData を名前の構造で入力にし、値を返したら Referer に 303 でリダイレクトする", async () => {
    let received: unknown;
    const { id } = register(
      defineServerFn((_c, { input }) => {
        received = input;
        return "saved";
      }),
    );
    const body = new FormData();
    body.append("title", "a");
    body.append("tags[]", "x");
    const response = await submit(id, body, { referer: "http://localhost/posts/1" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/posts/1");
    expect(received).toEqual({ title: "a", tags: ["x"] });
  });

  it("Referer が無ければ / に 303 でリダイレクトし、urlencoded の送信も受け付ける", async () => {
    const { id } = register(defineServerFn(() => null));
    const response = await submit(id, new URLSearchParams({ title: "a" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("redirect() は、その URL への 303 にする", async () => {
    const { id } = register(
      defineServerFn(() => {
        throw redirect("/done");
      }),
    );
    const response = await submit(id, new FormData());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/done");
  });

  it("handler が返した Response は、そのまま返す", async () => {
    const { id } = register(defineServerFn(() => new Response("page", { status: 200 })));
    expect(await (await submit(id, new FormData())).text()).toBe("page");
  });

  it("スキーマが失敗したら、422 の { issues } を返す", async () => {
    const { id } = register(defineServerFn({ input: title })(() => null));
    const response = await submit(id, new URLSearchParams({ title: "" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      issues: [{ message: "題名を入力してください", path: ["title"] }],
    });
  });

  it("それ以外の例外は、素のテキストの 500 にする", async () => {
    const { id } = register(
      defineServerFn(() => {
        throw new Error("boom");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await submit(id, new FormData());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("GET のサーバー関数への送信は 405 に、別のサイトからの送信は 403 にする", async () => {
    const { id: get } = register(defineServerFn({ method: "GET" })(() => null));
    expect((await submit(get, new FormData())).status).toBe(405);
    const { id: post } = register(defineServerFn(() => null));
    expect((await submit(post, new FormData(), { "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
  });
});
