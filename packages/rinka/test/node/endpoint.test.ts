import { defineMiddleware, type StandardSchema } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { fromJSON, toJSON } from "seroval";
import { describe, expect, it, vi } from "vitest";

import { toRpcInput } from "../../src/client/wire-codec.ts";
import { getContext } from "../../src/server/context.ts";
import type { OutcomeKind } from "../../src/server/endpoint.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn, serverFnModule } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type { AppOptions, Routes } from "../../src/shared/routes.ts";
import { rpcInputPart, rpcPath, submissionField, wireHeader } from "../../src/shared/wire.ts";
import { loadOf } from "./load.ts";

/** `value` が数の文字列なら数を返し、そうでなければ issues を返す Standard Schema である。 */
const numeric: StandardSchema<string, number> = {
  "~standard": {
    validate: (value: unknown) =>
      typeof value === "string" && /^\d+$/.test(value)
        ? { value: Number(value) }
        : { issues: [{ message: "数ではありません", path: ["n"] }] },
  },
};

let count = 0;

/** `fn` を一意な ID で登録し、その ID を返す。 */
function register(fn: Parameters<typeof registerServerFn>[1]): string {
  const id = `src/fns-${++count}.ts#fn`;
  registerServerFn(id, fn);
  return id;
}

/** ルートの無いアプリに、ID が `id` のサーバー関数へのリクエストを送る。`query` はクエリの文字列である。 */
async function call(
  id: string,
  init: RequestInit = {},
  { query = "", options = {} }: { query?: string; options?: AppOptions } = {},
): Promise<Response> {
  const app = createApp({ routes: [] }, options);
  return app.fetch(new Request(`http://localhost${rpcPath(id)}${query}`, init));
}

/** `/form` のページの行だけを持つルートの表である。ページは `<p>page</p>` を描画する。 */
const formRoutes: Routes = {
  routes: [
    {
      kind: "page",
      path: "/form",
      pattern: "/form",
      module: loadOf(() => jsx("p", { children: "page" })),
      layouts: [],
      middlewares: [],
    },
  ],
};

/** `/form` のページから、ID が `id` のサーバー関数を宛先にして、空のフォームを multipart/form-data で送信する。 */
async function submit(id: string): Promise<Response> {
  const body = new FormData();
  body.append(submissionField, id);
  return createApp(formRoutes).fetch(
    new Request("http://localhost/form", { method: "POST", body }),
  );
}

/** `body` を JSON で POST するリクエストを返す。 */
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** `value` を、クライアントと同じ形式の input の部分と、`parts` を番号の部分にした multipart で POST するリクエストを返す。 */
function multipart(value: unknown, parts: readonly Blob[]): RequestInit {
  const body = new FormData();
  body.append(rpcInputPart, JSON.stringify(toRpcInput(value).json));
  parts.forEach((part, index) => body.append(String(index), part));
  return { method: "POST", body };
}

describe("サーバー関数のエンドポイント", () => {
  it("POST の本文の JSON を入力にし、戻り値を { ok } で返す。c.status と c.header の設定を付ける", async () => {
    const id = register(
      defineServerFn({ input: numeric })((c, { input }) => {
        c.status(201);
        c.header("x-made", "yes");
        return input * 2;
      }),
    );
    const response = await call(id, post("21"));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-made")).toBe("yes");
    expect(response.headers.get(wireHeader)).toBe("rpc");
    expect(await response.json()).toEqual({ ok: 42 });
  });

  it("GET は ?d= の JSON を入力にする", async () => {
    const id = register(
      defineServerFn({ method: "GET", input: numeric })((_c, { input }) => input + 1),
    );
    const response = await call(id, {}, { query: `?d=${encodeURIComponent(JSON.stringify("4"))}` });
    expect(await response.json()).toEqual({ ok: 5 });
  });

  it("seroval の形式の入力を、GET の ?s= と、x-rinka-wire: seroval の POST から読み、素の JSON で表せない戻り値を { s } で返す", async () => {
    const id = register(
      defineServerFn({ method: "GET", input: (value: Date) => value })((_c, { input }) => input),
    );
    const date = new Date("2026-01-02T00:00:00Z");
    const query = `?s=${encodeURIComponent(JSON.stringify(toJSON(date)))}`;
    const body = (await (await call(id, {}, { query })).json()) as {
      s: Parameters<typeof fromJSON>[0];
    };
    expect(fromJSON(body.s)).toEqual(date);

    const posted = register(
      defineServerFn({ input: (value: Map<string, number>) => value })((_c, { input }) =>
        input.get("a"),
      ),
    );
    const response = await call(
      posted,
      post(toJSON(new Map([["a", 1]])), { [wireHeader]: "seroval" }),
    );
    expect(await response.json()).toEqual({ ok: 1 });
  });

  it("JSON として読めない入力と、seroval の形式に合わない入力は、400 を返す", async () => {
    let called = false;
    const id = register(
      defineServerFn(() => {
        called = true;
      }),
    );
    const broken = { method: "POST", headers: { "content-type": "application/json" }, body: "{" };
    expect((await call(id, broken)).status).toBe(400);
    expect((await call(id, post({ a: 1 }, { [wireHeader]: "seroval" }))).status).toBe(400);
    expect(called).toBe(false);
  });

  it("multipart の入力は、input の部分の seroval の JSON から、Blob の参照を番号の部分の File に置き換えて読む", async () => {
    let received: unknown;
    const id = register(
      defineServerFn({ input: (value: unknown) => value })((_c, { input }) => {
        received = input;
      }),
    );
    const photo = new File(["photo"], "photo.png", { type: "image/png" });
    const note = new Blob(["note"], { type: "text/plain" });
    const response = await call(id, multipart({ photo, pages: [note, photo] }, [photo, note]));
    expect(response.status).toBe(200);
    const value = received as { photo: File; pages: [File, File] };
    expect(value.photo).toBeInstanceOf(File);
    expect([value.photo.name, value.photo.type, await value.photo.text()]).toEqual([
      "photo.png",
      "image/png",
      "photo",
    ]);
    expect([value.pages[0].type, await value.pages[0].text()]).toEqual(["text/plain", "note"]);
    expect(value.pages[1]).toBe(value.photo);
  });

  it("multipart の入力の input の部分が無いとき、参照した番号の部分が無いとき、番号の部分が File でないときは、400 を返す", async () => {
    let called = false;
    const id = register(
      defineServerFn({ input: (value: unknown) => value })(() => {
        called = true;
      }),
    );
    const photo = new File(["x"], "x.txt");
    const missingInput = new FormData();
    missingInput.append("0", photo);
    expect((await call(id, { method: "POST", body: missingInput })).status).toBe(400);
    expect((await call(id, multipart({ photo }, []))).status).toBe(400);
    const text = multipart({ photo }, []);
    (text.body as FormData).append("0", "x");
    expect((await call(id, text)).status).toBe(400);
    expect(called).toBe(false);
  });

  it("multipart でない seroval の入力が Blob の参照を含むときは、400 を返す", async () => {
    const id = register(defineServerFn({ input: (value: unknown) => value })(() => null));
    const { json } = toRpcInput({ photo: new File(["x"], "x.txt") });
    expect((await call(id, post(json, { [wireHeader]: "seroval" }))).status).toBe(400);
  });

  it("handler が返した Response は、そのまま返す", async () => {
    const id = register(defineServerFn(() => new Response("file", { status: 200 })));
    const response = await call(id, post(null));
    expect(await response.text()).toBe("file");
    expect(response.headers.get(wireHeader)).toBeNull();
  });

  it("redirect() は 200 の { redirect } に、notFound() は 404 にする", async () => {
    const moved = register(
      defineServerFn(() => {
        throw redirect("/done");
      }),
    );
    const movedResponse = await call(moved, post(null));
    expect(movedResponse.status).toBe(200);
    expect(movedResponse.headers.get(wireHeader)).toBe("rpc");
    expect(await movedResponse.json()).toEqual({ redirect: "/done" });

    const missing = register(
      defineServerFn(() => {
        throw notFound();
      }),
    );
    const missingResponse = await call(missing, post(null));
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get(wireHeader)).toBe("rpc");
  });

  it("スキーマが失敗したら、422 の { issues } を返す", async () => {
    const id = register(defineServerFn({ input: numeric })(() => null));
    const response = await call(id, post("x"));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      issues: [{ message: "数ではありません", path: ["n"] }],
    });
  });

  it("メソッドが定義と異なれば 405 を、ID が未登録なら 404 を返す", async () => {
    const id = register(defineServerFn({ method: "GET" })(() => null));
    expect((await call(id, post(null))).status).toBe(405);
    expect((await call("src/none.ts#fn", post(null))).status).toBe(404);
  });

  it("ミドルウェアが返した Response を返し、外側のミドルウェアが next() の後に設定したヘッダーを付ける", async () => {
    const stamp = defineMiddleware(async (c, next) => {
      await next();
      c.header("x-stamp", "1");
    });
    const deny = defineMiddleware(async (c) => c.text("Unauthorized", 401));
    const id = register(defineServerFn(stamp, deny, () => "secret"));
    const response = await call(id, post(null));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(response.headers.get("x-stamp")).toBe("1");
  });

  it("ミドルウェアが投げた HTTPException は、その Response に、Context に設定したヘッダーを付けて返す", async () => {
    const stamp = defineMiddleware(async (c, next) => {
      await next();
      c.header("x-outer", "1");
    });
    const deny = defineMiddleware(async (c) => {
      c.header("set-cookie", "a=1");
      throw new HTTPException(403, { message: "forbidden" });
    });
    const id = register(defineServerFn(stamp, deny, () => null));
    const response = await call(id, post(null));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBe("a=1");
    expect(response.headers.get("x-outer")).toBe("1");
  });

  it("handler が返した Response にも、外側のミドルウェアが next() の後に設定したヘッダーを付ける", async () => {
    let seen: number | undefined;
    const stamp = defineMiddleware(async (c, next) => {
      await next();
      seen = c.res.status;
      c.header("x-outer", "1");
    });
    const id = register(defineServerFn(stamp, () => new Response("file", { status: 201 })));
    const response = await call(id, post(null));
    expect(response.headers.get("x-outer")).toBe("1");
    expect(seen).toBe(201);
  });

  it("GET のサーバー関数は HEAD でも呼び出せ、パーセントエンコーディングが不正な ID は 404 にする", async () => {
    const id = register(defineServerFn({ method: "GET" })(() => 1));
    expect((await call(id, { method: "HEAD" })).status).toBe(200);
    const app = createApp({ routes: [] });
    expect((await app.fetch(new Request("http://localhost/_rinka/fn/%E0%A4%A"))).status).toBe(404);
  });

  it("loadServerFn が投げたエラーは、アプリの onError に渡す", async () => {
    const broken = new Error("構文エラー");
    const onError = vi.fn(() => new Response(null, { status: 500 }));
    const loadServerFn = vi.fn(async (): Promise<boolean> => {
      throw broken;
    });
    const response = await call("src/broken.ts#fn", post(null), {
      options: { loadServerFn, onError },
    });
    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(broken);
  });

  it("それ以外の例外は、アプリの onError に渡して 500 を返す", async () => {
    const boom = new Error("boom");
    const onError = vi.fn(() => new Response(null, { status: 500 }));
    const id = register(
      defineServerFn(() => {
        throw boom;
      }),
    );
    const response = await call(id, post(null), { options: { onError } });
    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("handler が投げた rinka が扱わない例外はアプリの onError に 1 回だけ渡し、外側のミドルウェアの next() は正常に終了する", async () => {
    const boom = new Error("boom");
    const onError = vi.fn((_error: unknown) => new Response("failed", { status: 500 }));
    const after = defineMiddleware(async (c, next) => {
      await next();
      c.header("x-after", "1");
    });
    const id = register(
      defineServerFn(after, after, () => {
        throw boom;
      }),
    );
    const response = await call(id, post(null), { options: { onError } });
    expect([response.status, response.headers.get("x-after"), await response.text()]).toEqual([
      500,
      "1",
      "failed",
    ]);
    expect(onError.mock.calls).toEqual([[boom]]);
  });

  it("rinka が扱わない例外の 500 にも、ミドルウェアが next() の前に設定したヘッダーを付ける", async () => {
    const pre = defineMiddleware(async (c, next) => {
      c.header("x-pre", "1");
      await next();
    });
    const id = register(
      defineServerFn(pre, () => {
        throw new Error("boom");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn(() => new Response("failed", { status: 500 }));
    const responses = await Promise.all([
      call(id, post(null)),
      call(id, post(null), { options: { onError } }),
    ]);
    error.mockRestore();
    expect(responses.map((response) => [response.status, response.headers.get("x-pre")])).toEqual([
      [500, "1"],
      [500, "1"],
    ]);
  });

  it("Error 以外の投げられた値は、Error に包んでアプリの onError と c.error に渡す", async () => {
    let seen: unknown;
    const watch = defineMiddleware(async (c, next) => {
      await next();
      seen = c.error;
    });
    const onError = vi.fn((_error: unknown) => new Response(null, { status: 500 }));
    const id = register(
      defineServerFn(watch, () => {
        // oxlint-disable-next-line typescript/only-throw-error
        throw "str";
      }),
    );
    await call(id, post(null), { options: { onError } });
    const received = onError.mock.calls[0]?.[0];
    expect(received).toBeInstanceOf(Error);
    expect([String(received), (received as Error).cause]).toEqual(["Error: str", "str"]);
    expect(seen).toBe(received);
  });

  it("handler から直接呼んだサーバー関数のミドルウェアが返した Response を、RPC とフォームの送信のレスポンスにする", async () => {
    const deny = defineMiddleware(async (c) => c.text("Unauthorized", 401));
    const inner = defineServerFn(deny, () => "inner");
    const cookie = defineMiddleware(async (c, next) => {
      c.header("set-cookie", "a=1");
      await next();
    });
    const id = register(defineServerFn(cookie, async () => inner()));
    const responses = await Promise.all([call(id, post(null)), submit(id)]);
    const actual = await Promise.all(
      responses.map(async (response) => [
        response.status,
        response.headers.get("set-cookie"),
        await response.text(),
      ]),
    );
    expect(actual).toEqual([
      [401, "a=1", "Unauthorized"],
      [401, "a=1", "Unauthorized"],
    ]);
  });

  it("ミドルウェアが next() を呼ばずに、Response を返さずに終了すると、そのエラーをアプリの onError に渡す", async () => {
    const onError = vi.fn((_error: unknown) => new Response(null, { status: 500 }));
    const silent = defineMiddleware(async () => {});
    const id = register(defineServerFn(silent, () => null));
    const response = await call(id, post(null), { options: { onError } });
    expect(response.status).toBe(500);
    expect(String(onError.mock.calls[0]?.[0])).toBe(
      "Error: ミドルウェアは、next() を呼ぶか、Response を返してください。",
    );
  });

  it("loadServerFn が真を返したら ID のサーバー関数を探し、偽を返したら登録済みの ID でも 404 を返す", async () => {
    const id = "src/later.ts#fn";
    const loadServerFn = vi.fn(async (requested: string) => {
      if (requested !== id) return false;
      registerServerFn(
        id,
        defineServerFn(() => "loaded"),
      );
      return true;
    });
    const response = await call(id, post(null), { options: { loadServerFn } });
    expect(loadServerFn).toHaveBeenCalledWith(id);
    expect(await response.json()).toEqual({ ok: "loaded" });
    const stale = register(defineServerFn(() => "stale"));
    expect((await call(stale, post(null), { options: { loadServerFn } })).status).toBe(404);
  });
});

/** `headers` を付けて POST したときのステータスを返す。 */
const csrfStatus = async (headers: Record<string, string>, options: AppOptions = {}) => {
  const id = register(defineServerFn(() => null));
  return (await call(id, post(null, headers), { options })).status;
};

describe("CSRF の判定", () => {
  it("Sec-Fetch-Site が same-origin か none なら許可し、same-site か cross-site なら 403 にする", async () => {
    expect(await csrfStatus({ "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await csrfStatus({ "sec-fetch-site": "none" })).toBe(200);
    expect(await csrfStatus({ "sec-fetch-site": "same-site" })).toBe(403);
    expect(await csrfStatus({ "sec-fetch-site": "cross-site" })).toBe(403);
  });

  it("Sec-Fetch-Site が無ければ、Origin のホストをリクエストのホストと比べ、どちらも無ければ許可する", async () => {
    expect(await csrfStatus({ origin: "http://localhost" })).toBe(200);
    expect(await csrfStatus({ origin: "http://evil.example" })).toBe(403);
    expect(await csrfStatus({})).toBe(200);
  });

  it("trustedOrigins にある Origin は、Sec-Fetch-Site にかかわらず許可する", async () => {
    const options = { trustedOrigins: ["https://www.example.com"] };
    expect(
      await csrfStatus(
        { "sec-fetch-site": "cross-site", origin: "https://www.example.com" },
        options,
      ),
    ).toBe(200);
    expect(
      await csrfStatus(
        { "sec-fetch-site": "cross-site", origin: "https://other.example.com" },
        options,
      ),
    ).toBe(403);
  });

  it("GET には適用しない", async () => {
    const id = register(defineServerFn({ method: "GET" })(() => 1));
    const response = await call(id, { headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(200);
  });
});

describe("リクエストの種類ごとのレスポンス", () => {
  const handlers = {
    value: defineServerFn(() => 1),
    stream: defineServerFn(async function* () {
      yield 1;
    }),
    redirect: defineServerFn(() => {
      throw redirect("/done");
    }),
    notFound: defineServerFn(() => {
      throw notFound();
    }),
    schema: defineServerFn({ input: numeric })(() => null),
    http: defineServerFn(() => {
      throw new HTTPException(418, { message: "teapot" });
    }),
    error: defineServerFn(() => {
      throw new Error("boom");
    }),
  } satisfies Record<OutcomeKind | "notFound" | "http" | "redirect", unknown>;
  const ids = Object.fromEntries(
    Object.entries(handlers).map(([name, fn]) => [name, register(fn)]),
  ) as Record<keyof typeof handlers, string>;
  /** 送信したページの `/form` を描画した文書である。 */
  const page =
    '<!doctype html><html><head><meta charset="utf-8"></head><body><p>page</p></body></html>';
  const issues = JSON.stringify({ issues: [{ message: "数ではありません", path: ["n"] }] });
  const requests = {
    rpc: (id: string) => call(id, post(null)),
    form: (id: string) => submit(id),
  };
  const table: [keyof typeof requests, keyof typeof handlers, number, boolean, string][] = [
    ["rpc", "value", 200, true, '{"ok":1}'],
    ["rpc", "stream", 200, true, '{"ok":1}\n{"end":true}\n'],
    ["rpc", "redirect", 200, true, '{"redirect":"/done"}'],
    ["rpc", "notFound", 404, true, ""],
    ["rpc", "schema", 422, true, issues],
    ["rpc", "http", 418, false, "teapot"],
    ["form", "value", 200, false, page],
    ["form", "stream", 303, false, ""],
    ["form", "redirect", 303, false, ""],
    ["form", "notFound", 404, false, "Not Found"],
    ["form", "schema", 422, false, issues],
    ["form", "http", 418, false, "teapot"],
    ["rpc", "error", 500, false, "Internal Server Error"],
    ["form", "error", 500, false, "Internal Server Error"],
  ];

  it("種類と結果のすべての組で、ステータス、x-rinka-wire の有無、本文が表と一致する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const actual = await Promise.all(
      table.map(async ([kind, result]) => {
        const response = await requests[kind](ids[result]);
        return [
          kind,
          result,
          response.status,
          response.headers.has(wireHeader),
          await response.text(),
        ];
      }),
    );
    expect(actual).toEqual(table);
    vi.restoreAllMocks();
  });

  it("serverFnModule は、同じモジュールで前に登録したサーバー関数を削除してから、登録する関数を返す", async () => {
    const registerInModule = serverFnModule("src/module-reset.ts");
    registerInModule(
      "src/module-reset.ts#gone",
      defineServerFn(() => "gone"),
    );
    registerInModule(
      "src/module-reset.ts#kept",
      defineServerFn(() => "old"),
    );
    registerServerFn(
      "src/other.ts#other",
      defineServerFn(() => "other"),
    );
    serverFnModule("src/module-reset.ts")(
      "src/module-reset.ts#kept",
      defineServerFn(() => "new"),
    );
    expect((await call("src/module-reset.ts#gone", post(null))).status).toBe(404);
    expect(await (await call("src/module-reset.ts#kept", post(null))).json()).toEqual({
      ok: "new",
    });
    expect(await (await call("src/other.ts#other", post(null))).json()).toEqual({ ok: "other" });
  });
});

/** レスポンスの本文を、改行で区切った JSON の行として読む。 */
const lines = async (response: Response) =>
  (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

describe("async iterable を返すサーバー関数", () => {
  it("x-rinka-wire: stream のレスポンスで、値ごとに { ok } か { s } の行を送り、最後に { end: true } を送る", async () => {
    const id = register(
      defineServerFn(async function* () {
        yield 1;
        yield new Date(0);
      }),
    );
    const response = await call(id, post(null));
    expect([response.status, response.headers.get(wireHeader)]).toEqual([200, "stream"]);
    const [first, second, last] = await lines(response);
    expect(first).toEqual({ ok: 1 });
    expect(fromJSON((second as { s: Parameters<typeof fromJSON>[0] }).s)).toEqual(new Date(0));
    expect(last).toEqual({ end: true });
  });

  it("最初の値を得てからレスポンスを作るので、それまでに設定したステータス、ヘッダー、Cookie を付ける", async () => {
    const id = register(
      defineServerFn(async function* (c) {
        c.status(201);
        await Promise.resolve();
        c.header("x-made", "yes");
        c.header("set-cookie", "a=1");
        yield 1;
      }),
    );
    const response = await call(id, post(null));
    expect([
      response.status,
      response.headers.get("x-made"),
      response.headers.get("set-cookie"),
      await lines(response),
    ]).toEqual([201, "yes", "a=1", [{ ok: 1 }, { end: true }]]);
  });

  it("async 関数の handler が設定したヘッダーを、返した async iterable のレスポンスで送る", async () => {
    const id = register(
      defineServerFn(async (c) => {
        c.header("cache-control", "no-store");
        return (async function* () {
          yield 1;
        })();
      }),
    );
    const response = await call(id, post(null));
    expect([response.headers.get("cache-control"), await lines(response)]).toEqual([
      "no-store",
      [{ ok: 1 }, { end: true }],
    ]);
  });

  it("最初の値を得た後で、ミドルウェアがストリームでないレスポンスに置換したら、iterable の return を呼ぶ", async () => {
    let finished = false;
    const replace = defineMiddleware(async (c, next) => {
      await next();
      c.res = c.text("Forbidden", 403);
    });
    const id = register(
      defineServerFn(replace, async function* () {
        try {
          yield 1;
          yield 2;
        } finally {
          finished = true;
        }
      }),
    );
    const response = await call(id, post(null));
    expect([response.status, await response.text(), finished]).toEqual([403, "Forbidden", true]);
  });

  it("最初の値の前に投げた値は、ストリームでないサーバー関数と同じレスポンスにする", async () => {
    const missing = register(
      // oxlint-disable-next-line require-yield
      defineServerFn(async function* () {
        throw notFound();
      }),
    );
    const moved = register(
      // oxlint-disable-next-line require-yield
      defineServerFn(async function* () {
        throw redirect("/login");
      }),
    );
    const notFoundResponse = await call(missing, post(null));
    expect([notFoundResponse.status, notFoundResponse.headers.get(wireHeader)]).toEqual([
      404,
      "rpc",
    ]);
    const movedResponse = await call(moved, post(null));
    expect([movedResponse.headers.get(wireHeader), await movedResponse.json()]).toEqual([
      "rpc",
      { redirect: "/login" },
    ]);
  });

  it("最初の値をシリアライズできなければ、ストリームでない戻り値と同じく onError のレスポンスにし、iterable の return を呼ぶ", async () => {
    const onError = vi.fn((_error: unknown) => new Response("failed", { status: 500 }));
    let finished = false;
    const id = register(
      defineServerFn(async function* () {
        try {
          yield () => {};
        } finally {
          finished = true;
        }
      }),
    );
    const response = await call(id, post(null), { options: { onError } });
    expect([response.status, await response.text(), onError.mock.calls.length, finished]).toEqual([
      500,
      "failed",
      1,
      true,
    ]);
  });

  it("値をシリアライズできなければ、onError に渡して { error: true } の行を送り、iterable の return を呼ぶ。return が投げても行を送る", async () => {
    const onError = vi.fn((_error: unknown) => new Response(null, { status: 500 }));
    let finished = 0;
    const id = register(
      defineServerFn(async function* () {
        try {
          yield 1;
          yield () => {};
        } finally {
          finished++;
          // oxlint-disable-next-line no-unsafe-finally
          throw new Error("finally");
        }
      }),
    );
    const response = await call(id, post(null), { options: { onError } });
    expect([await lines(response), onError.mock.calls.length, finished]).toEqual([
      [{ ok: 1 }, { error: true }],
      1,
      1,
    ]);
  });

  it("generator の本体と finally と onError で、リクエストの Context を参照できる", async () => {
    const seen: boolean[] = [];
    const closed = Promise.withResolvers<void>();
    let request: unknown;
    const id = register(
      defineServerFn(async function* (c) {
        request = c;
        try {
          for (;;) {
            seen.push(getContext() === c);
            yield 1;
            // oxlint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } finally {
          seen.push(getContext() === c);
          closed.resolve();
        }
      }),
    );
    let failingRequest: unknown;
    const failing = register(
      defineServerFn(async function* (c) {
        failingRequest = c;
        yield 1;
        throw new Error("boom");
      }),
    );
    const reader = (await call(id, post(null))).body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await closed.promise;
    let failedContext: unknown;
    const onError = vi.fn((_error: unknown) => {
      failedContext = getContext();
      return new Response(null, { status: 500 });
    });
    await (await call(failing, post(null), { options: { onError } })).text();
    expect([seen, request !== undefined, failedContext === failingRequest]).toEqual([
      [true, true, true],
      true,
      true,
    ]);
  });

  it("途中で redirect() を投げたら { redirect } の行を、それ以外の例外はアプリの onError に渡して { error: true } の行を送って終わる", async () => {
    const boom = new Error("boom");
    const onError = vi.fn((_error: unknown) => new Response(null, { status: 500 }));
    const moved = register(
      defineServerFn(async function* () {
        yield 1;
        throw redirect("/done");
      }),
    );
    const failed = register(
      defineServerFn(async function* () {
        yield 1;
        throw boom;
      }),
    );
    expect(await lines(await call(moved, post(null)))).toEqual([{ ok: 1 }, { redirect: "/done" }]);
    const response = await call(failed, post(null), { options: { onError } });
    expect([response.status, await lines(response)]).toEqual([200, [{ ok: 1 }, { error: true }]]);
    expect(onError.mock.calls).toEqual([[boom]]);
  });

  it("レスポンスの本文の読み取りを中止すると、handler の iterable の return を呼ぶ", async () => {
    const closed = Promise.withResolvers<void>();
    const id = register(
      defineServerFn(async function* () {
        try {
          for (let n = 0; ; n++) {
            yield n;
            // oxlint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } finally {
          closed.resolve();
        }
      }),
    );
    const reader = (await call(id, post(null))).body!.getReader();
    await reader.read();
    await reader.cancel();
    await closed.promise;
  });
});
