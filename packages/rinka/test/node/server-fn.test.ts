import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { defineMiddleware, type StandardSchema } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { runInRequest } from "../../src/server/context.ts";
import { Loading } from "../../src/server/control.ts";
import { createApp } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { fileOfServerFnId, serverFnId } from "../../src/shared/server-fn.ts";

/** `value` が数の文字列なら数を返し、そうでなければ issues を返す Standard Schema である。 */
const numeric: StandardSchema<string, number> = {
  "~standard": {
    validate: (value: unknown) =>
      typeof value === "string" && /^\d+$/.test(value)
        ? { value: Number(value) }
        : { issues: [{ message: "数ではありません", path: ["n"] }] },
  },
};

/** `page` を `/posts` に置いたアプリに、`init` のリクエストを送り、レスポンスを返す。 */
function requestPage(page: () => unknown, init?: RequestInit): Promise<Response> {
  const app = createApp({
    routes: [
      {
        kind: "page",
        path: "/posts",
        module: async () => ({ default: page }),
        layouts: [],
        middlewares: [],
      },
    ],
  });
  return Promise.resolve(app.fetch(new Request("http://localhost/posts", init)));
}

describe("サーバー側から直接呼んだサーバー関数", () => {
  it("ミドルウェア、入力の検証、handler の順に実行し、handler の戻り値を返す", async () => {
    const order: string[] = [];
    const first = defineMiddleware(async (_c, next) => {
      order.push("first");
      await next();
      order.push("first:after");
    });
    const fn = defineServerFn({
      input: (value: string) => {
        order.push("validate");
        return Number(value);
      },
    })(first, (_c, { input }) => {
      order.push("handler");
      return input * 2;
    });
    expect(await fn("21")).toBe(42);
    expect(order).toEqual(["first", "validate", "handler", "first:after"]);
  });

  it("Standard Schema の検証が失敗すると、issues を持つエラーを投げ、handler を呼ばない", async () => {
    let called = false;
    const fn = defineServerFn({ input: numeric })(() => {
      called = true;
    });
    await expect(fn("x")).rejects.toMatchObject({
      issues: [{ message: "数ではありません", path: ["n"] }],
    });
    expect(called).toBe(false);
  });

  it("関数でもある Standard Schema は、Standard Schema として検証する", async () => {
    const schema = Object.assign(() => "関数として呼ばれた", numeric);
    const fn = defineServerFn({ input: schema })((_c, { input }) => input);
    expect(await fn("7")).toBe(7);
    await expect(fn("x")).rejects.toMatchObject({ issues: [{ message: "数ではありません" }] });
  });

  it("ミドルウェアが next を呼ばずに Response を返すと、handler を呼ばずに、その Response を投げる", async () => {
    let called = false;
    const unauthorized = new Response("Unauthorized", { status: 401 });
    const deny = defineMiddleware(async () => unauthorized);
    const fn = defineServerFn(deny, () => {
      called = true;
    });
    await expect(fn()).rejects.toBe(unauthorized);
    expect(called).toBe(false);
  });

  it("内側のミドルウェアが返した Response で、外側のミドルウェアの next() は正常に終了し、呼び出し元にはその Response を投げる", async () => {
    const order: string[] = [];
    const unauthorized = new Response("Unauthorized", { status: 401 });
    const outer = defineMiddleware(async (_c, next) => {
      await next();
      order.push("outer:after");
    });
    const deny = defineMiddleware(async () => unauthorized);
    const fn = defineServerFn(outer, deny, () => "secret");
    await expect(fn()).rejects.toBe(unauthorized);
    expect(order).toEqual(["outer:after"]);
  });

  it("ミドルウェアが投げた HTTPException は、そのまま呼び出し元に届く", async () => {
    const forbidden = new HTTPException(403, { message: "forbidden" });
    const deny = defineMiddleware(async () => {
      throw forbidden;
    });
    const fn = defineServerFn(deny, () => null);
    await expect(fn()).rejects.toBe(forbidden);
  });

  it("handler が投げた値は、ミドルウェアを通って呼び出し元に届く", async () => {
    const seen: unknown[] = [];
    const boom = new Error("boom");
    const watch = defineMiddleware(async (_c, next) => {
      try {
        await next();
      } catch (error) {
        seen.push(error);
        throw error;
      }
    });
    const fn = defineServerFn(watch, () => {
      throw boom;
    });
    await expect(fn()).rejects.toBe(boom);
    expect(seen).toEqual([boom]);
  });

  it("handler の失敗を受け止めたミドルウェアが Response を返すと、その Response を投げる", async () => {
    const recovered = new Response("recovered", { status: 500 });
    const recover = defineMiddleware(async (_c, next) => {
      try {
        await next();
        return undefined;
      } catch {
        return recovered;
      }
    });
    const fn = defineServerFn(recover, () => {
      throw new Error("boom");
    });
    await expect(fn()).rejects.toBe(recovered);
  });

  it("handler の失敗を受け止めたミドルウェアが Response を返さずに終了すると、handler の失敗を投げる", async () => {
    const boom = new Error("boom");
    const swallow = defineMiddleware(async (_c, next) => {
      try {
        await next();
      } catch {
        // 握りつぶす
      }
    });
    const fn = defineServerFn(swallow, () => {
      throw boom;
    });
    await expect(fn()).rejects.toBe(boom);
  });

  it("ミドルウェアが next を呼ばずに、Response を返さずに終了すると、エラーを投げる", async () => {
    const silent = defineMiddleware(async () => {});
    const fn = defineServerFn(silent, () => null);
    await expect(fn()).rejects.toThrow(
      "ミドルウェアは、next() を呼ぶか、Response を返してください。",
    );
  });

  it("ミドルウェアが next を 2 回呼ぶと、handler を 2 回目に実行せずにエラーを投げる", async () => {
    let calls = 0;
    const twice = defineMiddleware(async (_c, next) => {
      await next();
      await next();
    });
    const fn = defineServerFn(twice, () => {
      calls++;
    });
    await expect(fn()).rejects.toThrow("ミドルウェアは、next() を 1 回だけ呼んでください。");
    expect(calls).toBe(1);
  });

  it("処理中のリクエストの Context で実行し、ミドルウェアが設定した変数はその Context に残る", async () => {
    const auth = defineMiddleware<{ Variables: { user: string } }>(async (c, next) => {
      c.set("user", "ann");
      await next();
    });
    const fn = defineServerFn(auth, (c) => `${c.req.path}:${c.get("user")}`);
    const app = new Hono<{ Variables: { user: string } }>();
    let after: string | undefined;
    let result: string | undefined;
    app.get("*", async (c) => {
      result = await runInRequest(c, () => fn());
      after = c.get("user");
      return c.text("ok");
    });
    await app.request("/posts");
    expect(result).toBe("/posts:ann");
    expect(after).toBe("ann");
  });

  it("ページから直接呼んだサーバー関数の c.req は、ページの c.req と同じオブジェクトである", async () => {
    let received: unknown;
    const fn = defineServerFn((c) => {
      received = c.req;
      return null;
    });
    const app = new Hono();
    let page: unknown;
    app.get("*", async (c) => {
      page = c.req;
      await runInRequest(c, () => fn());
      return c.text("ok");
    });
    await app.request("/posts");
    expect(received).toBe(page);
  });

  it("リクエストの外では、/ へ GET するリクエストを表す空の Context で実行する", async () => {
    const fn = defineServerFn((c) => `${c.req.method} ${c.req.path}`);
    expect(await fn()).toBe("GET /");
  });
});

describe("ページの描画中に呼んだサーバー関数", () => {
  it("createApp のページは、ページのリクエストの Context でサーバー関数を実行する", async () => {
    const whoami = defineServerFn((c) => c.req.header("x-user") ?? "none");
    const Page = async () => `user:${await whoami()}`;
    const response = await requestPage(Page, { headers: { "x-user": "ann" } });
    expect(await response.text()).toContain("user:ann");
  });

  it("シェルを送った後に描画する部分でも、ページのリクエストの Context でサーバー関数を実行する", async () => {
    const whoami = defineServerFn((c) => c.req.header("x-user") ?? "none");
    const Later = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `deferred:${await whoami()}`;
    };
    const Page = () => jsx(Loading, { fallback: "…", children: jsx(Later, {}) });
    const response = await requestPage(Page, { headers: { "x-user": "ann" } });
    expect(await response.text()).toContain("deferred:ann");
  });

  it("ページから直接呼んだサーバー関数のミドルウェアが c.res を変更しても、ページのレスポンスは変わらない", async () => {
    const touch = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set("x-outer-res", "1");
      c.header("x-outer", "1");
    });
    const replace = defineMiddleware(async (c, next) => {
      await next();
      c.res = new Response("replaced", { status: 418 });
    });
    const fn = defineServerFn(touch, replace, () => "value");
    const response = await requestPage(async () => `page:${await fn()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-outer-res")).toBeNull();
    expect(response.headers.get("x-outer")).toBeNull();
    expect(await response.text()).toContain("page:value");
  });

  it("ミドルウェアが返した Response を、ページのレスポンスにする", async () => {
    const deny = defineMiddleware(async (c) => c.text("Unauthorized", 401));
    const secret = defineServerFn(deny, () => "secret");
    const response = await requestPage(async () => secret());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("ミドルウェアが返したリダイレクトを、ページのリダイレクトにする", async () => {
    const login = defineMiddleware(async (c) => c.redirect("/login"));
    const secret = defineServerFn(login, () => "secret");
    const response = await requestPage(async () => secret());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("basicAuth が投げた HTTPException の Response を、ページのレスポンスにする", async () => {
    const secret = defineServerFn(basicAuth({ username: "a", password: "b" }), () => "secret");
    const response = await requestPage(async () => secret());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });
});

describe("サーバー関数の ID", () => {
  it("ファイルと名前から作った ID から、ファイルを取り出せる。# を含まない ID は undefined にする", () => {
    expect(fileOfServerFnId(serverFnId("src/lib/a#b.ts", "like"))).toBe("src/lib/a#b.ts");
    expect(fileOfServerFnId("src/lib/a.ts")).toBeUndefined();
  });
});
