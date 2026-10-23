import type { Context, Handler, MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { getContext } from "../../src/server/api.ts";
import { notFound } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type { Route, RouteComponent, RouteMethod, Routes } from "../../src/shared/routes.ts";
import { rpcPath } from "../../src/shared/wire.ts";

/** `value` を default export するモジュールを読み込む関数を返す。 */
const module =
  <T>(value: T) =>
  async () => ({ default: value });

/** `tag` の要素で子を包み、`id` 属性を付けるレイアウトを返す。 */
const layout =
  (tag: string, id: string) =>
  ({ children }: { readonly children: unknown }) =>
    jsx(tag, { id, children });

/** `params.id` と `url.pathname` を属性に出力するレイアウトである。 */
const shell = ({
  params,
  url,
  children,
}: {
  readonly params: Record<string, string>;
  readonly url: URL;
  readonly children: unknown;
}) => jsx("div", { "data-id": params["id"], "data-path": url.pathname, children });

/** 受け取った props を文字列にして、`<p>` に出力するページを返す。 */
const page =
  (label: string) =>
  ({ params, url }: { readonly params: Record<string, string>; readonly url: URL }) =>
    jsx("p", { children: `${label} ${JSON.stringify(params)} ${url.search}` });

/** ページの行を返す。 */
function pageRoute(
  path: string,
  component: RouteComponent,
  layouts: readonly RouteComponent[] = [],
  middlewares: readonly MiddlewareHandler[] = [],
): Route {
  return {
    kind: "page",
    path,
    load: module(component),
    layouts: layouts.map(module),
    middlewares: middlewares.map(module),
  };
}

/** `not-found.tsx` か `error.tsx` の行を返す。 */
function specialRoute(
  kind: "not-found" | "error",
  path: string,
  component: RouteComponent,
  layouts: readonly RouteComponent[] = [],
): Route {
  return { kind, path, load: module(component), layouts: layouts.map(module), middlewares: [] };
}

/** `route.ts` の行を返す。 */
function apiRoute(
  path: string,
  handlers: Partial<Record<RouteMethod, Handler>>,
  middlewares: readonly MiddlewareHandler[] = [],
): Route {
  return {
    kind: "route",
    path,
    load: async () => handlers,
    layouts: [],
    middlewares: middlewares.map(module),
  };
}

/** ヘッダー `name` を `next()` の前に設定するミドルウェアを返す。 */
const marking =
  (name: string): MiddlewareHandler =>
  async (c: Context, next) => {
    c.header(name, "1");
    await next();
  };

/** 401 の Response を返すミドルウェアである。 */
const deny: MiddlewareHandler = async (c) => c.text("denied", 401);

/** `routes` のアプリに、`path` へのリクエストを送る。 */
function request(routes: Routes, path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(createApp(routes).fetch(new Request(`http://localhost${path}`, init)));
}

/** レスポンスの本文から、`<body>` の中身を返す。 */
async function bodyOf(response: Response): Promise<string> {
  const html = await response.text();
  return /<body>(.*)<\/body>/s.exec(html)?.[1] ?? html;
}

describe("createApp のページ", () => {
  it("ページを、外側から順にレイアウトで包み、params と url を props で渡す", async () => {
    const routes: Routes = {
      routes: [
        pageRoute("/users/:id", page("user"), [layout("div", "root"), layout("section", "users")]),
      ],
    };
    const response = await request(routes, "/users/3?q=x");
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toContain(
      '<div id="root"><section id="users"><p>user {"id":"3"} ?q=x</p></section></div>',
    );
  });

  it("レイアウトにも params と url を渡す", async () => {
    const response = await request(
      { routes: [pageRoute("/users/:id", page("user"), [shell])] },
      "/users/7",
    );
    expect(await bodyOf(response)).toContain('<div data-id="7" data-path="/users/7">');
  });

  it("表の順に登録するので、静的な区切りを動的な区切りとキャッチオールより優先する", async () => {
    const routes: Routes = {
      routes: [
        pageRoute("/docs/intro", page("intro")),
        pageRoute("/docs/:id", page("doc")),
        pageRoute("/docs/:slug{.+}", page("all")),
      ],
    };
    const bodies = await Promise.all(
      ["/docs/intro", "/docs/a", "/docs/a/b"].map(async (path) =>
        bodyOf(await request(routes, path)),
      ),
    );
    expect(bodies).toEqual([
      expect.stringContaining("<p>intro {} </p>"),
      expect.stringContaining('<p>doc {"id":"a"} </p>'),
      expect.stringContaining('<p>all {"slug":"a/b"} </p>'),
    ]);
  });
});

describe("createApp のミドルウェア", () => {
  const ping = defineServerFn(() => "pong");
  const id = "src/app-test.ts#ping";
  registerServerFn(id, ping);
  const routes: Routes = {
    middleware: module(marking("x-root")),
    routes: [
      pageRoute("/users", page("users"), [], [marking("x-dir")]),
      pageRoute("/about", page("about")),
      apiRoute("/api/users", { GET: () => ({ ok: true }) }, [marking("x-dir")]),
    ],
  };
  const headersOf = async (path: string, init?: RequestInit) => {
    const response = await request(routes, path, init);
    return [response.status, response.headers.get("x-root"), response.headers.get("x-dir")];
  };

  it("ルートの middleware.ts はすべてのリクエストに、ディレクトリの middleware.ts はその配下のルートだけに適用する", async () => {
    expect(
      await Promise.all([
        headersOf("/users"),
        headersOf("/about"),
        headersOf("/api/users"),
        headersOf(rpcPath(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        }),
      ]),
    ).toEqual([
      [200, "1", "1"],
      [200, "1", null],
      [200, "1", "1"],
      [200, "1", null],
    ]);
  });
});

describe("createApp のミドルウェアが返した Response", () => {
  it("ディレクトリの middleware.ts が返した Response を、ページの代わりに返す", async () => {
    const response = await request(
      { routes: [pageRoute("/admin", page("admin"), [], [deny])] },
      "/admin",
    );
    expect([response.status, await response.text()]).toEqual([401, "denied"]);
  });

  it("ルートの middleware.ts が返した Response を、ページの代わりに返す", async () => {
    const response = await request(
      { middleware: module(deny), routes: [pageRoute("/", page("top"))] },
      "/",
    );
    expect([response.status, await response.text()]).toEqual([401, "denied"]);
  });
});

describe("createApp の route.ts", () => {
  const routes: Routes = {
    routes: [
      apiRoute("/api/items/:id", {
        GET: (c) => ({ id: c.req.param("id") }),
        POST: () => undefined,
        DELETE: (c) => c.text("gone", 410),
      }),
    ],
  };

  it("Response 以外の戻り値は JSON にし、undefined は 204 にし、Response はそのまま返す", async () => {
    const [got, posted, deleted] = await Promise.all([
      request(routes, "/api/items/5"),
      request(routes, "/api/items/5", { method: "POST" }),
      request(routes, "/api/items/5", { method: "DELETE" }),
    ]);
    expect([got.status, got.headers.get("content-type"), await got.json()]).toEqual([
      200,
      "application/json",
      { id: "5" },
    ]);
    expect([posted.status, await posted.text()]).toEqual([204, ""]);
    expect([deleted.status, await deleted.text()]).toEqual([410, "gone"]);
  });

  it("export の無いメソッドには、export したメソッドを Allow に列挙した 405 を返す", async () => {
    const response = await request(routes, "/api/items/5", { method: "PUT" });
    expect([response.status, response.headers.get("allow")]).toEqual([405, "GET, POST, DELETE"]);
  });
});

/** `label` と url のパスを `<h1>` に出力するエラーのページを返す。`error` を受け取ったら、そのメッセージも出力する。 */
const fallback =
  (label: string) =>
  ({ url, error }: { readonly url: URL; readonly error?: unknown }) =>
    jsx("h1", {
      children: `${label} ${url.pathname}${error instanceof Error ? ` ${error.message}` : ""}`,
    });

/** `value` を投げるページである。 */
const throwing = (value: unknown) => () => {
  throw value;
};

describe("createApp の not-found.tsx と error.tsx", () => {
  const routes: Routes = {
    routes: [
      pageRoute("/users/:id", throwing(notFound())),
      pageRoute("/users/:id/edit", throwing(new Error("boom"))),
      pageRoute("/posts/:id", throwing(new Error("broken"))),
      specialRoute("not-found", "/", fallback("root")),
      specialRoute("error", "/", fallback("root")),
      specialRoute("not-found", "/users", fallback("users"), [layout("main", "users")]),
      specialRoute("error", "/users/:id", fallback("user")),
    ],
  };
  const render = async (path: string) => {
    const response = await request(routes, path);
    return [response.status, await bodyOf(response)];
  };

  it("表に無い URL には、URL の区切りが前方から一致するもののうち、最も深い not-found.tsx を、そのレイアウトで包んで 404 で返す", async () => {
    expect(await Promise.all([render("/users/3/x"), render("/other")])).toEqual([
      [404, expect.stringContaining('<main id="users"><h1>users /users/3/x</h1></main>')],
      [404, expect.stringContaining("<h1>root /other</h1>")],
    ]);
  });

  it("ページのシェルで投げた notFound() には、最も近い not-found.tsx を 404 で返す", async () => {
    expect(await render("/users/3")).toEqual([
      404,
      expect.stringContaining('<main id="users"><h1>users /users/3</h1></main>'),
    ]);
  });

  it("シェルで受け止められなかったエラーには、動的な区切りを含めて最も近い error.tsx を、投げられた値とともに 500 で返す", async () => {
    expect(await Promise.all([render("/users/3/edit"), render("/posts/1")])).toEqual([
      [500, expect.stringContaining("<h1>user /users/3/edit boom</h1>")],
      [500, expect.stringContaining("<h1>root /posts/1 broken</h1>")],
    ]);
  });

  it("該当するページが無ければ、Not Found と Internal Server Error のテキストを返す", async () => {
    const bare: Routes = {
      routes: [
        pageRoute("/boom", throwing(new Error("boom"))),
        pageRoute("/gone", throwing(notFound())),
      ],
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const responses = await Promise.all(
      ["/missing", "/gone", "/boom"].map((path) => request(bare, path)),
    );
    error.mockRestore();
    expect(
      await Promise.all(
        responses.map(async (response) => [response.status, await response.text()]),
      ),
    ).toEqual([
      [404, "Not Found"],
      [404, "Not Found"],
      [500, "Internal Server Error"],
    ]);
  });
});

/** リクエストのヘッダー `x-user` を `<p>` に出力するページである。 */
const reading = () => jsx("p", { children: getContext()?.req.header("x-user") });

describe("getContext", () => {
  it("ページとレイアウトの描画中は処理中のリクエストの Context を返し、リクエストの外では undefined を返す", async () => {
    const response = await request({ routes: [pageRoute("/", reading)] }, "/", {
      headers: { "x-user": "ann" },
    });
    expect(await bodyOf(response)).toContain("<p>ann</p>");
    expect(getContext()).toBeUndefined();
  });
});
