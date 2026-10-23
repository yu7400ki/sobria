import type { Context, Handler, MiddlewareHandler } from "hono";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getContext } from "../../src/server/api.ts";
import { notFound } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type {
  Fallback,
  Route,
  RouteComponent,
  RouteMethod,
  Routes,
} from "../../src/shared/routes.ts";
import { rpcPath } from "../../src/shared/wire.ts";

/** `value` を default export するモジュールを読み込む関数を返す。 */
const module =
  <T>(value: T) =>
  async () => ({ default: value });

/** `tag` の要素で子を包み、`id` 属性を付与するレイアウトを返す。 */
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
  fallbacks: Fallbacks = {},
): Route {
  return {
    kind: "page",
    path,
    load: module(component),
    layouts: layouts.map(module),
    middlewares: middlewares.map(module),
    ...fallbacks,
  };
}

/** ページと `not-found.tsx` の行の、エラーのページを表す。 */
interface Fallbacks {
  readonly notFound?: Fallback;
  readonly error?: Fallback;
}

/** `component` を `layouts` で包むエラーのページを返す。 */
const fallbackOf = (
  component: RouteComponent,
  layouts: readonly RouteComponent[] = [],
): Fallback => ({
  load: module(component),
  layouts: layouts.map(module),
});

/** `notFoundPage` の `not-found.tsx` の行を返す。 */
function notFoundRoute(
  path: string,
  notFoundPage: Fallback,
  middlewares: readonly MiddlewareHandler[] = [],
  error?: Fallback,
): Route {
  return {
    kind: "not-found",
    path,
    load: notFoundPage.load,
    layouts: notFoundPage.layouts,
    middlewares: middlewares.map(module),
    ...(error && { error }),
  };
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

/** Cookie の `session` を設定するミドルウェアである。 */
const session: MiddlewareHandler = async (c, next) => {
  setCookie(c, "session", "1");
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

  it("export の無いメソッドには、5 つ以外のメソッドも含めて、export したメソッドと HEAD を Allow に列挙した 405 を返す", async () => {
    const responses = await Promise.all(
      ["PUT", "OPTIONS"].map((method) => request(routes, "/api/items/5", { method })),
    );
    expect(responses.map((response) => [response.status, response.headers.get("allow")])).toEqual([
      [405, "GET, HEAD, POST, DELETE"],
      [405, "GET, HEAD, POST, DELETE"],
    ]);
  });

  it("HEAD は GET の関数で処理する", async () => {
    const response = await request(routes, "/api/items/5", { method: "HEAD" });
    expect(response.status).toBe(200);
  });

  it("Context で作成した Response には、ミドルウェアと関数が設定した Set-Cookie を 1 回ずつ付ける", async () => {
    const response = await request(
      {
        routes: [
          apiRoute(
            "/login",
            {
              GET: (c) => {
                setCookie(c, "user", "ann");
                return c.text("ok");
              },
            },
            [session],
          ),
        ],
      },
      "/login",
    );
    expect(response.headers.getSetCookie()).toEqual(["session=1; Path=/", "user=ann; Path=/"]);
  });

  it("同じ名前の Cookie を設定し直した順序を保つ", async () => {
    const response = await request(
      {
        routes: [
          apiRoute("/theme", {
            GET: (c) => {
              setCookie(c, "theme", "dark");
              setCookie(c, "theme", "light");
              setCookie(c, "theme", "dark");
              return c.text("ok");
            },
          }),
        ],
      },
      "/theme",
    );
    expect(response.headers.getSetCookie().at(-1)).toBe("theme=dark; Path=/");
  });

  it("関数が直接作成した Response の Set-Cookie は、ミドルウェアの Set-Cookie の後に加える", async () => {
    const response = await request(
      {
        routes: [
          apiRoute(
            "/raw-cookie",
            { GET: () => new Response("raw", { headers: { "set-cookie": "r=3" } }) },
            [session],
          ),
        ],
      },
      "/raw-cookie",
    );
    expect(response.headers.getSetCookie()).toEqual(["session=1; Path=/", "r=3"]);
  });

  it("関数が直接作成した Response にも、ミドルウェアが next() の前に設定したヘッダーを付ける", async () => {
    const response = await request(
      { routes: [apiRoute("/raw", { GET: () => new Response("raw") }, [marking("x-dir")])] },
      "/raw",
    );
    expect([await response.text(), response.headers.get("x-dir")]).toEqual(["raw", "1"]);
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
  const rootNotFound = fallbackOf(fallback("root"));
  const rootError = fallbackOf(fallback("root"));
  const usersNotFound = fallbackOf(fallback("users"), [layout("main", "users")]);
  const userError = fallbackOf(fallback("user"));
  const routes: Routes = {
    routes: [
      pageRoute("/users/:id", throwing(notFound()), [], [], {
        notFound: usersNotFound,
        error: rootError,
      }),
      pageRoute("/users/:id/edit", throwing(new Error("boom")), [], [], {
        notFound: usersNotFound,
        error: userError,
      }),
      pageRoute("/posts/:id", throwing(new Error("broken")), [], [], {
        notFound: rootNotFound,
        error: rootError,
      }),
      notFoundRoute("/", rootNotFound, [], rootError),
      notFoundRoute("/café", fallbackOf(fallback("cafe")), [], rootError),
      notFoundRoute("/p/:id", fallbackOf(page("p")), [], rootError),
      notFoundRoute("/users", usersNotFound, [marking("x-dir")], rootError),
    ],
  };
  const render = async (path: string) => {
    const response = await request(routes, path);
    return [response.status, await bodyOf(response), response.headers.get("x-dir")];
  };

  it("表に無い URL には、行の区切りが URL の区切りに前方から一致するもののうち、最も深い not-found.tsx を、そのレイアウトとミドルウェアとともに 404 で返す", async () => {
    expect(
      await Promise.all([render("/users/3/x"), render("/other"), render("/caf%C3%A9/1")]),
    ).toEqual([
      [404, expect.stringContaining('<main id="users"><h1>users /users/3/x</h1></main>'), "1"],
      [404, expect.stringContaining("<h1>root /other</h1>"), null],
      [404, expect.stringContaining("<h1>cafe /caf%C3%A9/1</h1>"), null],
    ]);
  });

  it("表に無い URL の not-found.tsx には、Hono と同じくデコードしたパラメータを渡す", async () => {
    expect((await render("/p/a%2Fb/x"))[1]).toContain('<p>p {"id":"a/b"} </p>');
  });

  it("ページのシェルで投げた notFound() には、ページの行の not-found.tsx を 404 で返す", async () => {
    expect(await render("/users/3")).toEqual([
      404,
      expect.stringContaining('<main id="users"><h1>users /users/3</h1></main>'),
      null,
    ]);
  });

  it("シェルで受け止められなかったエラーには、ページの行の error.tsx を、投げられた値とともに 500 で返し、エラーを記録する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rendered = await Promise.all([render("/users/3/edit"), render("/posts/1")]);
    const logged = error.mock.calls.map(([value]) =>
      value instanceof Error ? value.message : value,
    );
    error.mockRestore();
    expect(rendered).toEqual([
      [500, expect.stringContaining("<h1>user /users/3/edit boom</h1>"), null],
      [500, expect.stringContaining("<h1>root /posts/1 broken</h1>"), null],
    ]);
    expect(logged.map(String).toSorted((a, b) => a.localeCompare(b))).toEqual(["boom", "broken"]);
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
  it("ページの描画中は処理中のリクエストの Context を返し、リクエストの外では undefined を返す", async () => {
    const response = await request({ routes: [pageRoute("/", reading)] }, "/", {
      headers: { "x-user": "ann" },
    });
    expect(await bodyOf(response)).toContain("<p>ann</p>");
    expect(getContext()).toBeUndefined();
  });
});

/** ヘッダー `x-mw` と Cookie の `mw` を `next()` の前に設定するミドルウェアである。 */
const rootMarking: MiddlewareHandler = async (c, next) => {
  c.header("x-mw", "1");
  setCookie(c, "mw", "1");
  await next();
};

/** `status` と、`cookie` の Set-Cookie を持つ Response を作成する。 */
const raw = (status: number, cookie: string) =>
  new Response("raw", { status, headers: { "set-cookie": cookie } });

describe("Context のヘッダーを加えるレスポンスの出口", () => {
  const returned = "src/app-exits.ts#returned";
  const denied = "src/app-exits.ts#denied";
  const thrown = "src/app-exits.ts#thrown";
  registerServerFn(
    returned,
    defineServerFn(() => raw(200, "fn=1")),
  );
  registerServerFn(
    denied,
    defineServerFn(
      async () => raw(401, "deny=1"),
      () => 1,
    ),
  );
  registerServerFn(
    thrown,
    defineServerFn(() => {
      // oxlint-disable-next-line typescript/only-throw-error
      throw raw(409, "thrown=1");
    }),
  );
  const routes: Routes = {
    middleware: module(rootMarking),
    routes: [
      pageRoute("/page", page("page")),
      pageRoute("/shell", throwing(raw(401, "shell=1"))),
      apiRoute("/value", { GET: () => ({ ok: true }) }),
      apiRoute("/response", { GET: () => raw(200, "route=1") }),
      apiRoute("/http", {
        GET: () => {
          throw new HTTPException(403, { message: "forbidden" });
        },
      }),
      apiRoute("/error", {
        GET: () => {
          throw new Error("boom");
        },
      }),
    ],
  };
  const rpc = { method: "POST", headers: { "content-type": "application/json" }, body: "null" };

  it("ルートの middleware.ts が設定したヘッダーと Set-Cookie を、どの出口のレスポンスにも 1 回ずつ付ける", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const exits: readonly (readonly [string, RequestInit | undefined, string | undefined])[] = [
      ["/page", undefined, undefined],
      ["/shell", undefined, "shell=1"],
      ["/value", undefined, undefined],
      ["/response", undefined, "route=1"],
      ["/http", undefined, undefined],
      ["/error", undefined, undefined],
      [rpcPath(returned), rpc, "fn=1"],
      [rpcPath(denied), rpc, "deny=1"],
      [rpcPath(thrown), rpc, "thrown=1"],
    ];
    const results = await Promise.all(
      exits.map(async ([path, init, own]) => {
        const response = await request(routes, path, init);
        const expected = ["mw=1; Path=/", ...(own === undefined ? [] : [own])];
        return [path, response.headers.get("x-mw"), response.headers.getSetCookie(), expected];
      }),
    );
    expect(results.map(([path, mark, cookies]) => [path, mark, cookies])).toEqual(
      results.map(([path, , , expected]) => [path, "1", expected]),
    );
  });
});
