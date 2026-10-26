import type { StandardSchema } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";

import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/response.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { rpcPath, wireHeader } from "../../src/shared/wire.ts";

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
  return createApp({ routes: [] }).fetch(
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

  it("handler が async iterable を返したら、最後まで反復してから Referer に 303 でリダイレクトする", async () => {
    const steps: number[] = [];
    const { id } = register(
      defineServerFn(async function* () {
        for (const step of [1, 2, 3]) {
          steps.push(step);
          yield step;
        }
      }),
    );
    const response = await submit(id, new FormData(), { referer: "http://localhost/posts/1" });
    expect([response.status, response.headers.get("location")]).toEqual([
      303,
      "http://localhost/posts/1",
    ]);
    expect(steps).toEqual([1, 2, 3]);
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

  it("それ以外の例外はアプリの onError に渡し、onError が無ければ素のテキストの 500 にする", async () => {
    const { id } = register(
      defineServerFn(() => {
        throw new Error("boom");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await submit(id, new FormData());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    error.mockRestore();
    const app = createApp(
      { routes: [] },
      {
        onError: (thrown) => new Response(String(thrown), { status: 500 }),
      },
    );
    const handled = await app.fetch(
      new Request(`http://localhost${rpcPath(id)}`, { method: "POST", body: new FormData() }),
    );
    expect(await handled.text()).toBe("Error: boom");
  });

  it("notFound() は素のテキストの 404 に、HTTPException はそのレスポンスにする", async () => {
    const { id: missing } = register(
      defineServerFn(() => {
        throw notFound();
      }),
    );
    expect((await submit(missing, new FormData())).status).toBe(404);
    const { id: teapot } = register(
      defineServerFn(() => {
        throw new HTTPException(418, { message: "teapot" });
      }),
    );
    const response = await submit(teapot, new FormData());
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
  });

  it("フォームの本文を読めなければ、素のテキストの 400 にする", async () => {
    const { id } = register(defineServerFn(() => null));
    const response = await submit(id, new URLSearchParams(), {
      "content-type": "multipart/form-data; boundary=x",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request");
  });

  it("GET のサーバー関数への送信は 405 に、別のサイトからの送信は 403 に、未登録の ID と形式が不正な ID への送信は 404 にし、本文を素のテキストにする", async () => {
    const { id: get } = register(defineServerFn({ method: "GET" })(() => null));
    const { id: post } = register(defineServerFn(() => null));
    const responses = await Promise.all([
      submit(get, new FormData()),
      submit(post, new FormData(), { "sec-fetch-site": "cross-site" }),
      submit("src/forms-missing.ts#fn", new FormData()),
      createApp({ routes: [] }).fetch(
        new Request("http://localhost/_rinka/fn/%E0", { method: "POST", body: new FormData() }),
      ),
    ]);
    const actual = await Promise.all(
      responses.map(async (response) => [
        response.status,
        response.headers.has(wireHeader),
        await response.text(),
      ]),
    );
    expect(actual).toEqual([
      [405, false, "Method Not Allowed"],
      [403, false, "Forbidden"],
      [404, false, "Not Found"],
      [404, false, "Not Found"],
    ]);
  });
});
