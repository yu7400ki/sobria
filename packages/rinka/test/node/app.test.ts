import type { Context, Handler, MiddlewareHandler, Next } from "hono";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getContext, setBlockingRender } from "../../src/server/api.ts";
import { Loading } from "../../src/server/control.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import type {
  Fallback,
  Fallbacks,
  Route,
  RouteComponent,
  RouteMethod,
  Routes,
} from "../../src/shared/routes.ts";
import { rpcPath } from "../../src/shared/wire.ts";
import { loadOf } from "./load.ts";

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

/** 10 ms 待ってから `<p>done</p>` を返すコンポーネントである。 */
const slow = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return jsx("p", { children: "done" });
};

/** クエリの `blocking` が `1` のときだけ、すべての `<Loading>` を待つ描画を指定するミドルウェアである。 */
const choose: MiddlewareHandler = async (c, next) => {
  setBlockingRender(c, c.req.query("blocking") === "1");
  await next();
};

/** `slow` を `<Loading>` で包むページである。 */
const view = () =>
  jsx(Loading, { fallback: jsx("p", { children: "wait" }), children: jsx(slow, {}) });

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
    module: loadOf(component),
    layouts: layouts.map((value) => loadOf(value)),
    middlewares: middlewares.map((value) => loadOf(value)),
    ...fallbacks,
  };
}

/** `component` を `layouts` で包むエラーのページを返す。 */
const fallbackOf = (
  component: RouteComponent,
  layouts: readonly RouteComponent[] = [],
): Fallback => ({
  module: loadOf(component),
  layouts: layouts.map((value) => loadOf(value)),
});

/** ディレクトリのパス `path` にある `notFoundPage` の、`not-found.tsx` の行を返す。 */
function notFoundRoute(
  path: string,
  notFoundPage: Fallback,
  middlewares: readonly MiddlewareHandler[] = [],
  error?: Fallback,
): Route {
  return {
    kind: "not-found",
    path: path === "/" ? "/*" : `${path}/*`,
    middlewares: middlewares.map((value) => loadOf(value)),
    notFound: notFoundPage,
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
    module: async () => handlers,
    middlewares: middlewares.map((value) => loadOf(value)),
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

/** `/login` への `redirect()` を投げるミドルウェアである。 */
const guard: MiddlewareHandler = async () => {
  throw redirect("/login");
};

/** `notFound()` を投げるミドルウェアである。 */
const hide: MiddlewareHandler = async () => {
  throw notFound();
};

/** ヘッダーの `x-throw` に応じて、`redirect()`、`notFound()`、通常のエラーを投げるミドルウェアである。 */
const thrower: MiddlewareHandler = async (c, next) => {
  const kind = c.req.header("x-throw");
  if (kind === "redirect") throw redirect("/login", 307);
  if (kind === "notFound") throw notFound();
  if (kind === "error") throw new Error("root");
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

  it("bot の User-Agent のリクエストには、すべての <Loading> の中身を待って、フォールバックと差し替えの無い HTML を返す", async () => {
    const routes: Routes = { routes: [pageRoute("/", view)] };
    const bot = await bodyOf(
      await request(routes, "/", { headers: { "user-agent": "Googlebot/2.1" } }),
    );
    expect(bot).toContain("<p>done</p>");
    expect(bot).not.toContain("wait");
    expect(bot).not.toContain("$rinka");
    const person = await bodyOf(await request(routes, "/"));
    expect(person).toContain("<p>wait</p>");
    expect(person).toContain("$rinka");
  });

  it("ミドルウェアが setBlockingRender で指定した値は、User-Agent の判定より優先する", async () => {
    const routes: Routes = { routes: [pageRoute("/", view, [], [choose])] };
    const person = await bodyOf(await request(routes, "/?blocking=1"));
    expect(person).toContain("<p>done</p>");
    expect(person).not.toContain("$rinka");
    const bot = await bodyOf(
      await request(routes, "/?blocking=0", { headers: { "user-agent": "Googlebot/2.1" } }),
    );
    expect(bot).toContain("<p>wait</p>");
  });
});

describe("createApp のミドルウェア", () => {
  const ping = defineServerFn(() => "pong");
  const id = "src/app-test.ts#ping";
  registerServerFn(id, ping);
  const routes: Routes = {
    middleware: loadOf(marking("x-root")),
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

/** 503 の handled を返す onError である。 */
const handled = () => new Response("handled", { status: 503 });

describe("フォームの送信先のサーバー関数が投げたエラー", () => {
  const explode = defineServerFn(() => {
    throw new Error("kaboom");
  });
  const id = "src/app-test.ts#explode";
  registerServerFn(id, explode);
  const routes: Routes = {
    routes: [
      pageRoute("/users/:id/edit", page("edit"), [], [], {
        error: fallbackOf(fallback("user"), [layout("main", "users")]),
      }),
      notFoundRoute("/", fallbackOf(fallback("missing")), [], fallbackOf(fallback("root"))),
    ],
  };
  /** Referer を `referer` にして、フォームの送信を `id` のサーバー関数に送る。 */
  const submit = async (referer: string | undefined, headers: Record<string, string> = {}) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      error.mockRestore();
    });
    const response = await createApp(routes, { onError: handled }).fetch(
      new Request(`http://localhost${rpcPath(id)}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(referer !== undefined && { referer }),
          ...headers,
        },
        body: "a=1",
      }),
    );
    return { response, logged: error.mock.calls.map(([value]) => value) };
  };

  it("Referer のページの error.tsx を、そのレイアウトで包み、投げられた値とともに 500 で返し、エラーを記録する", async () => {
    const { response, logged } = await submit("http://localhost/users/3/edit");
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toContain(
      '<main id="users"><h1>user /users/3/edit kaboom</h1></main>',
    );
    expect(logged).toEqual([expect.objectContaining({ message: "kaboom" })]);
  });

  it("Referer が表に無い URL なら、その URL に一致する not-found.tsx の行の error.tsx を返す", async () => {
    const { response } = await submit("http://localhost/other");
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toContain("<h1>root /other kaboom</h1>");
  });

  it("x-rinka-refresh: 1 の送信には、error.tsx を描き直しの JSON で 500 にして返す", async () => {
    const { response } = await submit("http://localhost/users/3/edit", { "x-rinka-refresh": "1" });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { body: string }).body).toBe(
      '<main id="users"><h1>user /users/3/edit kaboom</h1></main>',
    );
  });

  it("Referer のスキームがリクエストの URL と異なっても、ホストが同じなら Referer のページの error.tsx を返す", async () => {
    const { response } = await submit("https://localhost/users/3/edit");
    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toContain("<h1>user /users/3/edit kaboom</h1>");
  });

  it("Referer が無いときと、ホストが異なるときは、onError のレスポンスを返す", async () => {
    const results = await Promise.all([
      submit(undefined),
      submit("http://example.com/users/3/edit"),
    ]);
    expect(
      await Promise.all(
        results.map(async ({ response }) => [response.status, await response.text()]),
      ),
    ).toEqual([
      [503, "handled"],
      [503, "handled"],
    ]);
  });
});

/** x-login のあるリクエストを、別のオリジンのログインのページにリダイレクトするミドルウェアである。 */
const loginGate: MiddlewareHandler = async (c, next) => {
  if (c.req.header("x-login") !== undefined)
    return c.redirect("https://auth.example.com/login", 302);
  await next();
  return undefined;
};

describe("x-rinka-refresh: 1 のフォームの送信のリダイレクト", () => {
  const ids = {
    saved: "src/app-test.ts#saved",
    moved: "src/app-test.ts#moved",
    handed: "src/app-test.ts#handed",
    guarded: "src/app-test.ts#guarded",
    flashing: "src/app-test.ts#flashing",
    scripted: "src/app-test.ts#scripted",
  };
  registerServerFn(
    ids.saved,
    defineServerFn(() => "saved"),
  );
  registerServerFn(
    ids.moved,
    defineServerFn(() => {
      throw redirect("/done");
    }),
  );
  registerServerFn(
    ids.handed,
    defineServerFn((c) => c.redirect("https://auth.example.com/login", 302)),
  );
  registerServerFn(
    ids.guarded,
    defineServerFn(
      async (c: Context, next: Next) =>
        c.req.method === "POST" ? c.redirect("/login", 302) : next(),
      () => "unreachable",
    ),
  );
  registerServerFn(
    ids.flashing,
    defineServerFn((c) => {
      setCookie(c, "flash", "1");
      return c.redirect("/form", 303);
    }),
  );
  registerServerFn(
    ids.scripted,
    defineServerFn((c) => c.redirect("javascript:alert(1)", 302)),
  );
  const routes: Routes = {
    middleware: loadOf(loginGate),
    routes: [
      pageRoute("/", () => jsx("p", { children: "page" })),
      notFoundRoute("/", fallbackOf(fallback("missing"))),
    ],
  };
  /** `id` のサーバー関数にフォームを送信する。 */
  const submit = (id: string, headers: Record<string, string> = {}) =>
    request(routes, rpcPath(id), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: "http://localhost/form?x=1",
        "x-rinka-refresh": "1",
        ...headers,
      },
      body: "a=1",
    });
  /** `id` のサーバー関数にフォームを送信し、ステータス、Location、本文の JSON を返す。 */
  const result = async (id: string, headers?: Record<string, string>) => {
    const response = await submit(id, headers);
    return [
      response.status,
      response.headers.get("location"),
      response.headers.get("x-rinka-wire"),
      await response.json(),
    ];
  };

  it("PRG、redirect()、handler とサーバー関数のミドルウェアとルートの middleware.ts が返したリダイレクトを、Location の値を持つ JSON にして 200 で返す", async () => {
    expect(
      await Promise.all([
        result(ids.saved),
        result(ids.moved),
        result(ids.handed),
        result(ids.guarded),
        result(ids.saved, { "x-login": "1" }),
      ]),
    ).toEqual([
      [200, null, "rpc", { redirect: "http://localhost/form?x=1" }],
      [200, null, "rpc", { redirect: "/done" }],
      [200, null, "rpc", { redirect: "https://auth.example.com/login" }],
      [200, null, "rpc", { redirect: "/login" }],
      [200, null, "rpc", { redirect: "https://auth.example.com/login" }],
    ]);
  });

  it("移動先が相対 URL でも http や https の URL でもないリダイレクトは、JSON にせずにそのまま返す", async () => {
    const response = await submit(ids.scripted);
    expect([response.status, response.headers.get("location")]).toEqual([
      302,
      "javascript:alert(1)",
    ]);
  });

  it("リダイレクトのレスポンスの Set-Cookie を、JSON のレスポンスに引き継ぐ", async () => {
    const response = await submit(ids.flashing);
    expect([response.status, response.headers.getSetCookie()]).toEqual([200, ["flash=1; Path=/"]]);
  });

  it("x-rinka-refresh の無いフォームの送信と、RPC には、リダイレクトのまま返す", async () => {
    const plain = await request(routes, rpcPath(ids.moved), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    const rpc = await request(routes, rpcPath(ids.saved), {
      method: "POST",
      headers: { "content-type": "application/json", "x-rinka-refresh": "1", "x-login": "1" },
      body: "null",
    });
    expect([plain.status, plain.headers.get("location")]).toEqual([303, "/done"]);
    expect([rpc.status, rpc.headers.get("location")]).toEqual([
      302,
      "https://auth.example.com/login",
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
      { middleware: loadOf(deny), routes: [pageRoute("/", page("top"))] },
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
      notFoundRoute("/café", fallbackOf(fallback("cafe")), [], rootError),
      notFoundRoute("/p/:id", fallbackOf(page("p")), [], rootError),
      notFoundRoute("/users", usersNotFound, [marking("x-dir")], rootError),
      notFoundRoute("/", rootNotFound, [], rootError),
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
  const unfinished = "src/app-exits.ts#unfinished";
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
  registerServerFn(
    unfinished,
    defineServerFn(
      async () => {},
      () => 1,
    ),
  );
  const routes: Routes = {
    middleware: loadOf(rootMarking),
    routes: [
      pageRoute("/page", page("page")),
      pageRoute("/shell", throwing(raw(401, "shell=1"))),
      pageRoute("/dir", page("dir"), [], [async () => raw(401, "dir=1")]),
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
      notFoundRoute("/", fallbackOf(fallback("root"))),
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
      [rpcPath(unfinished), rpc, undefined],
      ["/dir", undefined, "dir=1"],
      ["/missing", undefined, undefined],
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

/** ヘッダー `x-mw` と Cookie の `mw` を設定してから、Set-Cookie を持つ 401 の Response を返すミドルウェアである。 */
const returningOwn: MiddlewareHandler = async (c) => {
  c.header("x-mw", "1");
  setCookie(c, "mw", "1");
  return raw(401, "own=1");
};

describe("ルートの middleware.ts が返した Response", () => {
  it("Response を返す前に設定したヘッダーと Set-Cookie を加える", async () => {
    const response = await request({ middleware: loadOf(returningOwn), routes: [] }, "/");
    expect([
      response.status,
      response.headers.get("x-mw"),
      response.headers.getSetCookie(),
    ]).toEqual([401, "1", ["mw=1; Path=/", "own=1"]]);
  });
});

/** `/login` へリダイレクトするミドルウェアである。 */
const toLogin: MiddlewareHandler = async (c) => c.redirect("/login");

describe("表に無い URL の not-found.tsx", () => {
  const routes: Routes = {
    routes: [
      pageRoute("/users/:id", page("user")),
      notFoundRoute("/docs/:slug{.+}", fallbackOf(page("doc"))),
      notFoundRoute("/users/new", fallbackOf(fallback("new"))),
      notFoundRoute("/users/:id", fallbackOf(fallback("user"))),
      notFoundRoute("/users", fallbackOf(fallback("users"))),
      notFoundRoute("/shop", fallbackOf(fallback("shop a"))),
      notFoundRoute("/shop", fallbackOf(fallback("shop b"))),
      notFoundRoute("/admin", fallbackOf(fallback("admin")), [toLogin]),
      notFoundRoute("/", fallbackOf(fallback("root"))),
    ],
  };
  const render = async (path: string, init?: RequestInit) => {
    const response = await request(routes, path, init);
    const body = await bodyOf(response);
    return [response.status, /<(?:h1|p)>(.*?)<\/(?:h1|p)>/.exec(body)?.[1] ?? body];
  };

  it("末尾が / の URL には、そのディレクトリの not-found.tsx を返す", async () => {
    expect(await render("/users/")).toEqual([404, "users /users/"]);
  });

  it("ページがある URL への GET 以外のメソッドと、表に無い URL への HEAD にも、最も深い not-found.tsx を 404 で返す", async () => {
    expect(await render("/users/3", { method: "POST" })).toEqual([404, "user /users/3"]);
    expect((await request(routes, "/nothing", { method: "HEAD" })).status).toBe(404);
  });

  it("同じ深さでは静的な区切りを、同じパスでは表で先の行を使用する", async () => {
    expect(await Promise.all([render("/users/new/x"), render("/shop/x")])).toEqual([
      [404, "new /users/new/x"],
      [404, "shop a /shop/x"],
    ]);
  });

  it("キャッチオールのディレクトリの not-found.tsx に、残りの区切りをパラメータにして渡す", async () => {
    expect(await render("/docs/a/b/c", { method: "POST" })).toEqual([404, 'doc {"slug":"a/b/c"} ']);
  });

  it("not-found.tsx のディレクトリのミドルウェアが返した Response を、not-found.tsx の代わりに返す", async () => {
    const response = await request(routes, "/admin/x");
    expect([response.status, response.headers.get("location")]).toEqual([302, "/login"]);
  });
});

/** Vary に cookie を設定する middleware である。 */
const varying: MiddlewareHandler = async (c, next) => {
  c.header("vary", "cookie");
  await next();
};

describe("描き直しのレスポンス", () => {
  const refreshRoutes: Routes = {
    routes: [
      pageRoute("/", () => jsx("p", { children: "page" }), [], [], {
        notFound: fallbackOf(() => jsx("p", { children: "missing" })),
      }),
      notFoundRoute(
        "/",
        fallbackOf(() => jsx("p", { children: "missing" })),
      ),
    ],
  };
  const refreshing = { headers: { "x-rinka-refresh": "1" } };

  it("x-rinka-refresh: 1 のリクエストには、ページを描き直しの JSON で返す", async () => {
    const response = await request(refreshRoutes, "/", refreshing);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { body: string }).body).toBe("<p>page</p>");
  });

  it("表に無い URL には、not-found.tsx を描き直しの JSON で 404 にして返す", async () => {
    const response = await request(refreshRoutes, "/x", refreshing);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { body: string }).body).toBe("<p>missing</p>");
  });

  it("ページのレスポンスには、描き直しかどうかにかかわらず Vary: x-rinka-refresh を付ける", async () => {
    const plain = await request(refreshRoutes, "/");
    const refreshed = await request(refreshRoutes, "/", refreshing);
    expect([plain.headers.get("vary"), refreshed.headers.get("vary")]).toEqual([
      "x-rinka-refresh",
      "x-rinka-refresh",
    ]);
    expect(plain.headers.get("content-type")).toContain("text/html");
  });

  it("middleware が設定した Vary に、x-rinka-refresh を加える", async () => {
    const response = await request(
      { routes: [pageRoute("/", () => jsx("p", { children: "page" }), [], [varying])] },
      "/",
    );
    expect(response.headers.get("vary")).toBe("cookie, x-rinka-refresh");
  });
});

describe("Context のヘッダー", () => {
  it("Context の Vary を含むレスポンスでは、Vary の値を重ねない", async () => {
    const response = await request(
      { routes: [apiRoute("/", { GET: (c) => c.text("ok") }, [varying])] },
      "/",
    );
    expect(response.headers.get("vary")).toBe("cookie");
  });
});

describe("サーバー関数のリクエストで、ルートの middleware.ts が投げた値", () => {
  const routes: Routes = {
    middleware: loadOf(thrower),
    routes: [
      pageRoute("/users/:id/edit", page("edit"), [], [], {
        error: fallbackOf(fallback("user")),
      }),
      notFoundRoute("/", fallbackOf(fallback("missing"))),
    ],
  };
  /** `x-throw` を `kind` にして、`body` をサーバー関数のエンドポイントに送る。 */
  const send = (kind: string, type: string, body: string, headers: Record<string, string> = {}) =>
    request(routes, rpcPath("src/app-test.ts#unknown"), {
      method: "POST",
      headers: { "content-type": type, "x-throw": kind, ...headers },
      body,
    });

  it("ページのリクエストでは、notFound() に URL に一致する not-found.tsx を使用する", async () => {
    const response = await request(routes, "/nope", { headers: { "x-throw": "notFound" } });
    expect([response.status, await bodyOf(response)]).toEqual([404, "<h1>missing /nope</h1>"]);
  });

  it("RPC では、サーバー関数が投げた値と同じく、redirect() を { redirect } に、notFound() を本文の無い 404 にする", async () => {
    const [moved, gone] = await Promise.all([
      send("redirect", "application/json", "null"),
      send("notFound", "application/json", "null"),
    ]);
    expect([moved.status, await moved.json()]).toEqual([200, { redirect: "/login" }]);
    expect([gone.status, await gone.text()]).toEqual([404, ""]);
  });

  it("フォームの送信では、redirect() を 303 に、notFound() を素のテキストの 404 に、通常のエラーを Referer のページの error.tsx にする", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      error.mockRestore();
    });
    const form = "application/x-www-form-urlencoded";
    const [moved, gone, broken] = await Promise.all([
      send("redirect", form, "a=1"),
      send("notFound", form, "a=1"),
      send("error", form, "a=1", { referer: "http://localhost/users/3/edit" }),
    ]);
    expect([moved.status, moved.headers.get("location")]).toEqual([303, "/login"]);
    expect([gone.status, await gone.text()]).toEqual([404, "Not Found"]);
    expect([broken.status, await bodyOf(broken)]).toEqual([
      500,
      "<h1>user /users/3/edit root</h1>",
    ]);
  });

  it("フォームの送信で使用した error.tsx のシェルが投げたエラーは、onError に渡す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      error.mockRestore();
    });
    const onError = vi.fn(handled);
    const app = createApp(
      {
        middleware: loadOf(thrower),
        routes: [
          pageRoute("/broken", page("broken"), [], [], {
            error: fallbackOf(throwing(new Error("shell"))),
          }),
        ],
      },
      { onError },
    );
    const submit = (id: string, kind: string) =>
      Promise.resolve(
        app.fetch(
          new Request(`http://localhost${rpcPath(id)}`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              referer: "http://localhost/broken",
              "x-throw": kind,
            },
            body: "a=1",
          }),
        ),
      );
    const [fromHandler, fromMiddleware] = await Promise.all([
      submit("src/app-test.ts#explode", "none"),
      submit("src/app-test.ts#unknown", "error"),
    ]);
    expect([fromHandler.status, fromMiddleware.status]).toEqual([503, 503]);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("アプリの onError", () => {
  it("HTTPException は、onError を呼ばずに、そのレスポンスにする", async () => {
    const onError = vi.fn(handled);
    const routes: Routes = {
      routes: [
        apiRoute("/http", {
          GET: () => {
            throw new HTTPException(401, { message: "denied" });
          },
        }),
      ],
    };
    const response = await createApp(routes, { onError }).fetch(
      new Request("http://localhost/http"),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("denied");
    expect(onError).not.toHaveBeenCalled();
  });

  it("route.ts とディレクトリの middleware.ts が投げた redirect() と notFound() は、onError を呼ばずに、移動と not-found.tsx の 404 にする", async () => {
    const onError = vi.fn(handled);
    const routes: Routes = {
      routes: [
        apiRoute("/api/moved", {
          GET: () => {
            throw redirect("/api/new", 307);
          },
        }),
        apiRoute("/api/gone", {
          GET: () => {
            throw notFound();
          },
        }),
        pageRoute("/admin", page("admin"), [], [guard]),
        apiRoute("/api/broken", {
          GET: () => {
            throw new Error("broken");
          },
        }),
        notFoundRoute("/", fallbackOf(fallback("missing"))),
      ],
    };
    const app = createApp(routes, { onError });
    const fetch = (path: string) =>
      Promise.resolve(app.fetch(new Request(`http://localhost${path}`)));
    const [moved, gone, admin, broken] = await Promise.all([
      fetch("/api/moved"),
      fetch("/api/gone"),
      fetch("/admin"),
      fetch("/api/broken"),
    ]);
    expect([moved.status, moved.headers.get("location")]).toEqual([307, "/api/new"]);
    expect([gone.status, await bodyOf(gone)]).toEqual([404, "<h1>missing /api/gone</h1>"]);
    expect([admin.status, admin.headers.get("location")]).toEqual([303, "/login"]);
    expect(broken.status).toBe(503);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ページの URL でミドルウェアが投げた notFound() は、ページの not-found.tsx を 404 で返し、not-found.tsx のシェルが投げたエラーには error.tsx を使用する", async () => {
    const routes: Routes = {
      routes: [
        pageRoute("/shop", page("shop"), [], [hide], {
          notFound: fallbackOf(fallback("shop")),
        }),
        apiRoute("/broken/api", {
          GET: () => {
            throw notFound();
          },
        }),
        notFoundRoute(
          "/broken",
          fallbackOf(throwing(new Error("nf"))),
          [],
          fallbackOf(fallback("error")),
        ),
        notFoundRoute("/", fallbackOf(fallback("root"))),
      ],
    };
    const [shop, broken] = await Promise.all([
      request(routes, "/shop"),
      request(routes, "/broken/api"),
    ]);
    expect([shop.status, await bodyOf(shop)]).toEqual([404, "<h1>shop /shop</h1>"]);
    expect([broken.status, await bodyOf(broken)]).toEqual([500, "<h1>error /broken/api nf</h1>"]);
  });
});
