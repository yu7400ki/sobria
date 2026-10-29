import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getContext } from "../../src/server/context.ts";
import { redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { href } from "../../src/shared/router.ts";
import type { Routes } from "../../src/shared/routes.ts";
import { rpcPath, submissionField } from "../../src/shared/wire.ts";
import { loadOf } from "./load.ts";

beforeEach(() => {
  vi.stubEnv("BASE_URL", "/sub/");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeAll(() => {
  registerServerFn(
    "src/base-fns.ts#ping",
    defineServerFn(() => "pong"),
  );
  registerServerFn(
    "src/base-fns.ts#nothing",
    defineServerFn(() => undefined),
  );
  registerServerFn(
    "src/base-fns.ts#toAbout",
    defineServerFn(() => {
      throw redirect((href as (route: string) => string)("/about"));
    }),
  );
});

/** `/about` のページの行だけを持つルートの表である。ページは、受け取った URL のパスと、Hono のコンテキストの `user` を描画する。 */
const routes: Routes = {
  routes: [
    {
      kind: "page",
      path: "/about",
      pattern: "/about",
      module: loadOf((props: { url: URL }) =>
        jsx("p", { children: `${props.url.pathname} ${String(getContext()?.get("user"))}` }),
      ),
      layouts: [],
      middlewares: [],
    },
  ],
};

/** サーバー関数 `id` を宛先にした、`/sub/about` からのフォームの送信を、アプリ `app` に送る。`headers` をヘッダーに加える。 */
const submit = (app: Hono, id: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request("http://localhost/sub/about", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: `${submissionField}=${encodeURIComponent(id)}`,
    }),
  );

describe("アプリを配置するパスが /sub/ のとき", () => {
  it("href と RPC のパスは、配置するパスで始まる", () => {
    expect(
      (href as (route: string, params?: object, query?: object) => string)("/about", {}, { q: 1 }),
    ).toBe("/sub/about?q=1");
    expect(rpcPath("src/fns.ts#fn")).toBe("/sub/_rinka/fn/src%2Ffns.ts%23fn");
  });

  it("配置するパスの下のページを、リクエストの URL のまま描画し、配置するパスの外は 404 にする", async () => {
    const app = createApp(routes);
    const page = await app.fetch(new Request("http://localhost/sub/about"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<p>/sub/about undefined</p>");
    expect((await app.fetch(new Request("http://localhost/about"))).status).toBe(404);
  });

  it("アプリを登録した Hono のアプリのミドルウェアが設定した値を、ページで読める", async () => {
    const server = new Hono<{ Variables: { user: string } }>();
    server.use(async (c, next) => {
      c.set("user", "alice");
      await next();
    });
    server.route("/", createApp(routes));
    const page = await server.fetch(new Request("http://localhost/sub/about"));
    expect(await page.text()).toContain("<p>/sub/about alice</p>");
  });

  it("配置するパスの下の _rinka/fn/ で RPC を受け付け、配置するパスの外の /_rinka/fn/ は 404 にする", async () => {
    const app = createApp(routes);
    const id = encodeURIComponent("src/base-fns.ts#ping");
    const call = (path: string) =>
      app.fetch(new Request(`http://localhost${path}${id}`, { method: "POST" }));
    expect(await (await call("/sub/_rinka/fn/")).json()).toEqual({ ok: "pong" });
    expect((await call("/_rinka/fn/")).status).toBe(404);
  });

  it("JS が無いフォームの送信で handler が undefined を返したら、配置するパスを含む送信したページへ 303 で移動する", async () => {
    const response = await submit(createApp(routes), "src/base-fns.ts#nothing");
    expect([response.status, response.headers.get("location")]).toEqual([303, "/sub/about"]);
  });

  it("JS があるフォームの送信で handler が undefined を返したら、送信したページを描き直す", async () => {
    const response = await submit(createApp(routes), "src/base-fns.ts#nothing", {
      "x-rinka-page": "http://localhost/sub/about",
    });
    const json = (await response.json()) as { redirect?: string; page?: unknown };
    expect([json.redirect, json.page === undefined]).toEqual(["/sub/about", false]);
  });

  it("RPC で、呼び出したページへの redirect() を投げたら、移動先のページの描き直しを返す", async () => {
    const response = await createApp(routes).fetch(
      new Request(`http://localhost${rpcPath("src/base-fns.ts#toAbout")}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rinka-page": "http://localhost/sub/about",
        },
        body: "null",
      }),
    );
    const json = (await response.json()) as { redirect?: string; page?: unknown };
    expect([json.redirect, json.page === undefined]).toEqual(["/sub/about", false]);
  });
});

it("アプリを配置するパスに URL で符号化した文字があっても、その下のページを描画する", async () => {
  vi.stubEnv("BASE_URL", "/my%20app/");
  try {
    const page = await createApp(routes).fetch(new Request("http://localhost/my%20app/about"));
    expect(page.status).toBe(200);
  } finally {
    vi.unstubAllEnvs();
  }
});
