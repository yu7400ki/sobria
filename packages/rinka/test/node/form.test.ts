import type { StandardSchema } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";

import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToString } from "../../src/server/response.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type { AppOptions, Routes } from "../../src/shared/routes.ts";
import { submissionField, wireHeader } from "../../src/shared/wire.ts";
import { loadOf } from "./load.ts";

let count = 0;

/** `fn` を一意な ID で登録し、ID と登録した関数を返す。 */
function register<F extends Parameters<typeof registerServerFn>[1]>(fn: F): { id: string; fn: F } {
  const id = `src/forms-${++count}.ts#fn`;
  return { id, fn: registerServerFn(id, fn) };
}

/** `/posts/:id` のページの行だけを持つルートの表である。 */
const routes: Routes = {
  routes: [
    {
      kind: "page",
      path: "/posts/:id",
      pattern: "/posts/[id]",
      module: loadOf(() => jsx("p", { children: "post" })),
      layouts: [],
      middlewares: [],
    },
  ],
};

/**
 * `/posts/1` のページから、ID が `id` のサーバー関数を宛先にして、`body` をフォームとして送信したレスポンスを返す。
 * `body` には、`_rinka_fn` の欄を加えてから送信する。
 */
function submit(
  id: string,
  body: FormData | URLSearchParams,
  headers: Record<string, string> = {},
  options: AppOptions = {},
) {
  body.append(submissionField, id);
  return createApp(routes, options).fetch(
    new Request("http://localhost/posts/1", { method: "POST", body, headers }),
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
  it("action を出力せずに、method を post に、enctype を multipart/form-data にし、サーバー関数の ID を持つ hidden input を最初の子にする", async () => {
    const { id, fn } = register(defineServerFn(() => null));
    const html = await renderToString(jsx("form", { action: fn, children: "x" }));
    expect(html).toBe(
      `<form method="post" enctype="multipart/form-data"><input type="hidden" name="${submissionField}" value="${id}">x</form>`,
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
  it("_rinka_fn の欄を除いた FormData を、名前の構造で handler の入力にする", async () => {
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
    await submit(id, body);
    expect(received).toEqual({ title: "a", tags: ["x"] });
  });

  it("handler が async iterable を返したら、最後まで反復してから送信したページに 303 でリダイレクトする", async () => {
    const steps: number[] = [];
    const { id } = register(
      defineServerFn(async function* () {
        for (const step of [1, 2, 3]) {
          steps.push(step);
          yield step;
        }
      }),
    );
    const response = await submit(id, new FormData());
    expect([response.status, response.headers.get("location")]).toEqual([303, "/posts/1"]);
    expect(steps).toEqual([1, 2, 3]);
  });

  it.each([
    ["ホストがリクエストと異なる", "http://example.com/other"],
    ["パスが /_rinka/ の下にある", "http://localhost/_rinka/fn/x"],
  ])(
    "送信の Referer の URL の%s場合も、Referer を参照せずに、undefined を返したときも async iterable を返したときも送信したページに 303 でリダイレクトする",
    async (_, referer) => {
      const value = register(defineServerFn(() => undefined));
      const stream = register(
        defineServerFn(async function* () {
          yield 1;
        }),
      );
      for (const { id } of [value, stream]) {
        // oxlint-disable-next-line no-await-in-loop
        const response = await submit(id, new FormData(), { referer });
        expect([response.status, response.headers.get("location")]).toEqual([303, "/posts/1"]);
      }
    },
  );

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
    const handled = await submit(
      id,
      new FormData(),
      {},
      { onError: (thrown) => new Response(String(thrown), { status: 500 }) },
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

  it("GET のサーバー関数への送信は 405 に、別のサイトからの送信は 403 に、未登録の ID への送信は 404 にし、本文を素のテキストにする", async () => {
    const { id: get } = register(defineServerFn({ method: "GET" })(() => null));
    const { id: post } = register(defineServerFn(() => null));
    const responses = await Promise.all([
      submit(get, new FormData()),
      submit(post, new FormData(), { "sec-fetch-site": "cross-site" }),
      submit("src/forms-missing.ts#fn", new FormData()),
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
    ]);
  });
});
