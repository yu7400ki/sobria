import { defineMiddleware, type StandardSchema } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { fromJSON, toJSON } from "seroval";
import { describe, expect, it, vi } from "vitest";

import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type { AppOptions } from "../../src/shared/routes.ts";
import { rpcPath, wireHeader } from "../../src/shared/wire.ts";

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
  const app = createApp([], options);
  return app.fetch(new Request(`http://localhost${rpcPath(id)}${query}`, init));
}

/** `body` を JSON で POST するリクエストを返す。 */
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

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
    const app = createApp([]);
    expect((await app.fetch(new Request("http://localhost/_rinka/fn/%E0%A4%A"))).status).toBe(404);
  });

  it("loadModule が投げたエラーは、アプリの onError に渡す", async () => {
    const broken = new Error("構文エラー");
    const onError = vi.fn(() => new Response(null, { status: 500 }));
    const loadModule = vi.fn(async () => {
      throw broken;
    });
    const response = await call("src/broken.ts#fn", post(null), {
      options: { loadModule, onError },
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

  it("未登録の ID は、loadModule で ID のモジュールの部分を読み込んでから探し直す", async () => {
    const id = "src/later.ts#fn";
    const loadModule = vi.fn(async (path: string) => {
      if (path === "src/later.ts")
        registerServerFn(
          id,
          defineServerFn(() => "loaded"),
        );
    });
    const response = await call(id, post(null), { options: { loadModule } });
    expect(loadModule).toHaveBeenCalledWith("src/later.ts");
    expect(await response.json()).toEqual({ ok: "loaded" });
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
