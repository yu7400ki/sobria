import type { Context, Handler, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getContext, setBlockingRender } from "../../src/server/api.ts";
import { Loading } from "../../src/server/control.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { createApp, registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { prerenderEnv } from "../../src/shared/prerender.ts";
import type {
  DirectoryMiddleware,
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

/** Hono のパス `path` を、ファイルの形のパスにする。 */
const patternOf = (path: string): string =>
  path.replaceAll(/:(\w+)\{\.\+\}/g, "[...$1]").replaceAll(/:(\w+)/g, "[$1]");

/** ディレクトリの `middleware.ts` の欄の値を返す。関数は、`notFound()` に使用する `not-found.tsx` の無いミドルウェアにする。 */
const directoryOf = (value: MiddlewareHandler | DirectoryMiddleware): DirectoryMiddleware =>
  typeof value === "function" ? { module: loadOf(value) } : value;

/** `notFound()` を投げたときに `fallbacks` を使用する、ディレクトリの `middleware.ts` を返す。 */
const guarded = (handler: MiddlewareHandler, fallbacks: Fallbacks): DirectoryMiddleware => ({
  module: loadOf(handler),
  ...fallbacks,
});

/** ページの行を返す。 */
function pageRoute(
  path: string,
  component: RouteComponent,
  layouts: readonly RouteComponent[] = [],
  middlewares: readonly (MiddlewareHandler | DirectoryMiddleware)[] = [],
  fallbacks: Fallbacks = {},
): Route {
  return {
    kind: "page",
    path,
    pattern: patternOf(path),
    module: loadOf(component),
    layouts: layouts.map((value) => loadOf(value)),
    middlewares: middlewares.map(directoryOf),
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
  middlewares: readonly (MiddlewareHandler | DirectoryMiddleware)[] = [],
  error?: Fallback,
): Route {
  return {
    kind: "not-found",
    path: path === "/" ? "/*" : `${path}/*`,
    middlewares: middlewares.map(directoryOf),
    notFound: notFoundPage,
    ...(error && { error }),
  };
}

/** `route.ts` の行を返す。`fallbacks` は、関数が投げた `notFound()` に使用するエラーのページである。 */
function apiRoute(
  path: string,
  handlers: Partial<Record<RouteMethod, Handler>>,
  middlewares: readonly (MiddlewareHandler | DirectoryMiddleware)[] = [],
  fallbacks: Fallbacks = {},
): Route {
  return {
    kind: "route",
    path,
    pattern: patternOf(path),
    module: Object.assign(async () => handlers, { file: `src/routes${path}/route.ts` }),
    middlewares: middlewares.map(directoryOf),
    ...fallbacks,
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

/** `next()` の後で `notFound()` を投げるミドルウェアである。 */
const late: MiddlewareHandler = async (_c, next) => {
  await next();
  throw notFound();
};

/** ヘッダーの `x-throw` に応じて、`redirect()` と `notFound()` を投げ、POST のリクエストでは通常のエラーを投げるミドルウェアである。 */
const thrower: MiddlewareHandler = async (c, next) => {
  const kind = c.req.header("x-throw");
  if (kind === "redirect") throw redirect("/login", 307);
  if (kind === "notFound") throw notFound();
  if (kind === "error" && c.req.method === "POST") throw new Error("root");
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

  it("書き出しのリクエストには、setBlockingRender の値にかかわらず、すべての <Loading> の中身を待った HTML を返す", async () => {
    const app = createApp({ routes: [pageRoute("/", view, [], [choose])] });
    const html = await bodyOf(
      await app.fetch(new Request("http://localhost/?blocking=0"), { [prerenderEnv]: "page" }),
    );
    expect(html).toContain("<p>done</p>");
    expect(html).not.toContain("$rinka");
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

  it("x-rinka-page のある送信には、Referer の代わりに x-rinka-page の URL のページの error.tsx を、描き直しの JSON で 500 にして返す", async () => {
    const { response } = await submit("http://localhost/other", {
      "x-rinka-page": "http://localhost/users/3/edit",
    });
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

/** Cookie の flash の値を c.var.flash に設定し、レスポンスの後で Cookie を削除するミドルウェアである。 */
const flashGate: MiddlewareHandler = async (c, next) => {
  const flash = getCookie(c, "flash");
  if (flash !== undefined) c.set("flash", flash);
  await next();
  if (flash !== undefined) deleteCookie(c, "flash");
};

/** 描き直しの JSON の本文が `body` であることを表す。 */
const refreshedTo = (body: string) => expect.objectContaining({ body });

/** c.var.flash と、リクエストの x-test と accept-encoding のヘッダーを出力するページである。 */
const flashPage = () => {
  const c = getContext();
  return jsx("p", {
    children: `${String(c?.get("flash"))} ${String(c?.req.header("x-test"))} ${String(c?.req.header("accept-encoding"))}`,
  });
};

/** JSON として読めない本文を、JSON の Content-Type で返すミドルウェアである。 */
const brokenJson: MiddlewareHandler = async (c) =>
  c.body("{", 200, { "content-type": "application/json" });

/** c.var.org に、パラメータの id を設定するミドルウェアである。 */
const orgGate: MiddlewareHandler = async (c, next) => {
  c.set("org", `org-${c.req.param("id") ?? ""}`);
  await next();
};

/** Cookie の `root` を設定するミドルウェアである。 */
const rootCookie: MiddlewareHandler = async (c, next) => {
  setCookie(c, "root", "1");
  await next();
};

/** c.var.org を `data-org` 属性に出力するレイアウトである。 */
const orgLayout = ({ children }: { readonly children: unknown }) =>
  jsx("section", { "data-org": String(getContext()?.get("org")), children });

describe("フォームの送信が失敗したときの、送信したページへのサブリクエスト", () => {
  const explode = defineServerFn(() => {
    throw new Error("kaboom");
  });
  const id = "src/app-test.ts#explode-subrequest";
  registerServerFn(id, explode);
  const rootNotFound = fallbackOf(fallback("root"));
  const orgError = fallbackOf(fallback("org"), [orgLayout]);
  const routes: Routes = {
    middleware: loadOf(rootCookie),
    routes: [
      pageRoute("/orgs/:id", page("org"), [orgLayout], [orgGate], { error: orgError }),
      pageRoute("/private", page("private"), [], [guard], { error: orgError }),
      pageRoute(
        "/kept",
        page("kept"),
        [],
        [
          async () => {
            throw redirect("/login", 307);
          },
        ],
        { error: orgError },
      ),
      pageRoute("/hidden", page("hidden"), [], [guarded(hide, { notFound: rootNotFound })], {
        error: orgError,
      }),
      pageRoute("/plain", page("plain")),
      pageRoute("/session", page("session"), [], [session], { error: orgError }),
      pageRoute(
        "/session-moved",
        page("session-moved"),
        [],
        [
          async (c) => {
            setCookie(c, "session", "1");
            throw redirect("/login", 308);
          },
        ],
        { error: orgError },
      ),
      apiRoute("/api/html", { GET: (c) => c.html("<form>api</form>") }),
    ],
  };
  /** Referer を `referer` にしてフォームを送信する。`js` が真なら、`x-rinka-page` も `referer` にする。`logged` には、`console.error` に渡した値を加える。 */
  const submit = async (referer: string, js = false, logged: unknown[] = []) => {
    const error = vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      logged.push(value);
    });
    onTestFinished(() => {
      error.mockRestore();
    });
    return createApp(routes, { onError: handled }).fetch(
      new Request(`http://localhost${rpcPath(id)}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer,
          ...(js && { "x-rinka-page": referer }),
        },
        body: "a=1",
      }),
    );
  };

  it("ページのディレクトリの middleware.ts を実行してから error.tsx を描画するので、レイアウトは middleware.ts が c.set した値を参照できる", async () => {
    const response = await submit("http://localhost/orgs/7");
    expect([response.status, await bodyOf(response)]).toEqual([
      500,
      '<section data-org="org-7"><h1>org /orgs/7 kaboom</h1></section>',
    ]);
  });

  it("middleware.ts がリダイレクトしたら、JS が無いときはリダイレクトのレスポンスに、JS があるときは { redirect } にする", async () => {
    const [plain, js] = await Promise.all([
      submit("http://localhost/private"),
      submit("http://localhost/private", true),
    ]);
    expect([plain.status, plain.headers.get("location")]).toEqual([303, "/login"]);
    expect([js.status, await js.json()]).toEqual([200, { redirect: "/login" }]);
  });

  it("JS が無いときは、middleware.ts の 307 のリダイレクトを 303 にする", async () => {
    const [plain, js] = await Promise.all([
      submit("http://localhost/kept"),
      submit("http://localhost/kept", true),
    ]);
    expect([plain.status, plain.headers.get("location")]).toEqual([303, "/login"]);
    expect([js.status, await js.json()]).toEqual([200, { redirect: "/login" }]);
  });

  it("サーバー関数が投げた値は、error.tsx を描画したときも、middleware.ts が拒否したときも、1 回だけ記録する", async () => {
    const logged: unknown[] = [];
    await submit("http://localhost/orgs/7", false, logged);
    await submit("http://localhost/private", false, logged);
    await submit("http://localhost/hidden", true, logged);
    await submit("http://localhost/api/html", false, logged);
    expect(logged.map((value) => (value instanceof Error ? value.message : value))).toEqual([
      "kaboom",
      "kaboom",
      "kaboom",
    ]);
  });

  it("middleware.ts が notFound() を投げたら、親から探索した not-found.tsx を 404 で返す", async () => {
    const [plain, js] = await Promise.all([
      submit("http://localhost/hidden"),
      submit("http://localhost/hidden", true),
    ]);
    expect([plain.status, await bodyOf(plain)]).toEqual([404, "<h1>root /hidden</h1>"]);
    expect([js.status, ((await js.json()) as { body: string }).body]).toEqual([
      404,
      "<h1>root /hidden</h1>",
    ]);
  });

  it("サブリクエストの middleware.ts が設定した Cookie を、ルートの middleware.ts の Cookie とともに、フォームの送信のレスポンスに 1 回ずつ付ける", async () => {
    const responses = await Promise.all([
      submit("http://localhost/session"),
      submit("http://localhost/session", true),
      submit("http://localhost/session-moved"),
    ]);
    expect(responses.map((response) => [response.status, response.headers.getSetCookie()])).toEqual(
      [
        [500, ["root=1; Path=/", "session=1; Path=/"]],
        [500, ["root=1; Path=/", "session=1; Path=/"]],
        [303, ["root=1; Path=/", "session=1; Path=/"]],
      ],
    );
  });

  it("JS があるときは、x-rinka-page の URL のホストが異なれば、同じホストの Referer があっても onError のレスポンスを返す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      error.mockRestore();
    });
    const response = await createApp(routes, { onError: handled }).fetch(
      new Request(`http://localhost${rpcPath(id)}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: "http://localhost/orgs/7",
          "x-rinka-page": "http://example.com/orgs/7",
        },
        body: "a=1",
      }),
    );
    expect([response.status, await response.text()]).toEqual([503, "handled"]);
  });

  it("送信したページの URL に一致する行が、error.tsx の無いページか、route.ts か、/_rinka/ の下か、無いときは、onError のレスポンスを返す", async () => {
    const urls = ["/plain", "/api/html", rpcPath(id), "/nowhere"];
    const responses = await Promise.all(urls.map((url) => submit(`http://localhost${url}`)));
    expect(
      await Promise.all(
        responses.map(async (response) => [response.status, await response.text()]),
      ),
    ).toEqual(urls.map(() => [503, "handled"]));
  });
});

describe("JS からのサーバー関数の呼び出し", () => {
  const ids = {
    created: "src/app-test.ts#created",
    dated: "src/app-test.ts#dated",
    read: "src/app-test.ts#read",
    readMoved: "src/app-test.ts#readMoved",
    saved: "src/app-test.ts#saved",
    moved: "src/app-test.ts#moved",
    handed: "src/app-test.ts#handed",
    guarded: "src/app-test.ts#guarded",
    flashing: "src/app-test.ts#flashing",
    scripted: "src/app-test.ts#scripted",
    streamed: "src/app-test.ts#streamed",
    readStreamed: "src/app-test.ts#readStreamed",
    streamedHere: "src/app-test.ts#streamedHere",
    streamedAway: "src/app-test.ts#streamedAway",
  };
  registerServerFn(
    ids.streamedHere,
    defineServerFn(async function* () {
      yield 1;
      throw redirect("/form?x=1#top");
    }),
  );
  registerServerFn(
    ids.streamedAway,
    defineServerFn(async function* () {
      yield 1;
      throw redirect("/elsewhere");
    }),
  );
  registerServerFn(
    ids.streamed,
    defineServerFn(async function* () {
      yield 1;
    }),
  );
  registerServerFn(
    ids.readStreamed,
    defineServerFn({ method: "GET" })(async function* () {
      yield 1;
    }),
  );
  registerServerFn(
    ids.saved,
    defineServerFn(() => "saved"),
  );
  registerServerFn(
    ids.dated,
    defineServerFn(() => new Date(0)),
  );
  registerServerFn(
    ids.read,
    defineServerFn({ method: "GET" })(() => "read"),
  );
  registerServerFn(
    ids.readMoved,
    defineServerFn({ method: "GET" })((c) => c.redirect("/form?x=1", 302)),
  );
  registerServerFn(
    ids.created,
    defineServerFn((c) => {
      c.status(201);
      return "created";
    }),
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
      return c.redirect("/form?x=1", 303);
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
      pageRoute("/form", flashPage, [], [flashGate]),
      pageRoute("/guarded", flashPage, [], [toLogin]),
      pageRoute("/broken", flashPage, [], [brokenJson]),
      notFoundRoute("/", fallbackOf(fallback("missing"))),
    ],
  };
  /** `id` のサーバー関数に、`/form?x=1` のページからフォームを送信する。 */
  const submit = (id: string, headers: Record<string, string> = {}) =>
    request(routes, rpcPath(id), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: "http://localhost/referer",
        "x-rinka-page": "http://localhost/form?x=1#top",
        "x-test": "t",
        "accept-encoding": "gzip",
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

  it("PRG、redirect()、handler とサーバー関数のミドルウェアとルートの middleware.ts が返したリダイレクトを、Location の値を持つ JSON にして 200 で返す。PRG の移動先は x-rinka-page の URL で、そのページの描き直しを page に含める", async () => {
    expect(
      await Promise.all([
        result(ids.saved),
        result(ids.moved),
        result(ids.handed),
        result(ids.guarded),
        result(ids.saved, { "x-login": "1" }),
      ]),
    ).toEqual([
      [
        200,
        null,
        "rpc",
        {
          redirect: "http://localhost/form?x=1#top",
          page: refreshedTo("<p>undefined t undefined</p>"),
        },
      ],
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

  it("リダイレクトのレスポンスの Set-Cookie を反映した Cookie で描き直し、描き直しのレスポンスの Set-Cookie を加えて返す", async () => {
    const response = await submit(ids.flashing, { cookie: "flash=0; other=2" });
    expect([response.status, response.headers.getSetCookie(), await response.json()]).toEqual([
      200,
      ["flash=1; Path=/", "flash=; Max-Age=0; Path=/"],
      { redirect: "/form?x=1", page: refreshedTo("<p>1 t undefined</p>") },
    ]);
  });

  it("相対 URL の移動先は、x-rinka-page の URL のオリジンで解決して比べる", async () => {
    const response = await submit(ids.flashing, { "x-rinka-page": "https://localhost/form?x=1" });
    expect(await response.json()).toEqual({
      redirect: "/form?x=1",
      page: refreshedTo("<p>1 t undefined</p>"),
    });
  });

  it("描き直しのレスポンスが JSON でないときと、JSON として読めないときは、page を含めない", async () => {
    const results = await Promise.all(
      ["http://localhost/guarded", "http://localhost/broken"].map(async (url) => {
        const response = await submit(ids.saved, { "x-rinka-page": url });
        return response.json();
      }),
    );
    expect(results).toEqual([
      { redirect: "http://localhost/guarded" },
      { redirect: "http://localhost/broken" },
    ]);
  });

  it("フォームの送信でないページのリクエストは、x-rinka-page があっても HTML の文書で返す", async () => {
    const response = await request(routes, "/", { headers: { "x-rinka-page": "a" } });
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("x-rinka-page の URL のホストがリクエストと異なるときと、/_rinka/ の下にあるときは、Referer が同じホストの URL でも / に戻り、描き直さない", async () => {
    const results = await Promise.all(
      ["http://example.com/form?x=1", "http://localhost/_rinka/fn/x"].map(async (url) => {
        const response = await submit(ids.saved, { "x-rinka-page": url });
        return response.json();
      }),
    );
    expect(results).toEqual([{ redirect: "/" }, { redirect: "/" }]);
  });

  it("x-rinka-page の無いフォームの送信には、リダイレクトのまま返す", async () => {
    const plain = await request(routes, rpcPath(ids.moved), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect([plain.status, plain.headers.get("location")]).toEqual([303, "/done"]);
  });

  /** `/form?x=1` のページから、`id` のサーバー関数を `method` の RPC で呼び出し、ステータスと本文の JSON を返す。 */
  const call = async (id: string, headers: Record<string, string> = {}, method = "POST") => {
    const response = await request(routes, rpcPath(id), {
      method,
      headers: {
        ...(method === "POST" && { "content-type": "application/json" }),
        "x-rinka-page": "http://localhost/form?x=1",
        ...headers,
      },
      ...(method === "POST" && { body: "null" }),
    });
    return [response.status, await response.json()];
  };

  it("RPC の { ok } と { s } と、x-rinka-page の URL への { redirect } に、そのページの描き直しを page に含める", async () => {
    expect(await Promise.all([call(ids.saved), call(ids.dated), call(ids.flashing)])).toEqual([
      [200, { ok: "saved", page: refreshedTo("<p>undefined undefined undefined</p>") }],
      [200, { s: expect.anything(), page: refreshedTo("<p>undefined undefined undefined</p>") }],
      [200, { redirect: "/form?x=1", page: refreshedTo("<p>1 undefined undefined</p>") }],
    ]);
  });

  /** `/form?x=1` のページから、`id` のサーバー関数を `method` の RPC で呼び出し、本文の行を JSON として返す。 */
  const lines = async (id: string, method: string) => {
    const response = await request(routes, rpcPath(id), {
      method,
      headers: {
        ...(method === "POST" && { "content-type": "application/json" }),
        "x-rinka-page": "http://localhost/form?x=1",
      },
      ...(method === "POST" && { body: "null" }),
    });
    return (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  };

  it("async iterable のストリームでは、最後の { end: true } の行にページの描き直しを含め、GET では含めない", async () => {
    expect(await lines(ids.streamed, "POST")).toEqual([
      { ok: 1 },
      { end: true, page: refreshedTo("<p>undefined undefined undefined</p>") },
    ]);
    expect(await lines(ids.readStreamed, "GET")).toEqual([{ ok: 1 }, { end: true }]);
  });

  it("ストリームの移動先を伝える行には、移動先が呼び出し元のページのときだけ、ページの描き直しを含める", async () => {
    expect([await lines(ids.streamedHere, "POST"), await lines(ids.streamedAway, "POST")]).toEqual([
      [
        { ok: 1 },
        { redirect: "/form?x=1#top", page: refreshedTo("<p>undefined undefined undefined</p>") },
      ],
      [{ ok: 1 }, { redirect: "/elsewhere" }],
    ]);
  });

  it("RPC では、x-rinka-page が無くても、handler とミドルウェアが返したリダイレクトを { redirect } にし、page を含めない", async () => {
    expect(
      await Promise.all([
        call(ids.handed, { "x-rinka-page": "" }),
        call(ids.saved, { "x-rinka-page": "", "x-login": "1" }),
        call(ids.moved),
      ]),
    ).toEqual([
      [200, { redirect: "https://auth.example.com/login" }],
      [200, { redirect: "https://auth.example.com/login" }],
      [200, { redirect: "/done" }],
    ]);
  });

  it("2xx の { ok } には、handler が設定したステータスのまま page を含める", async () => {
    expect(await call(ids.created)).toEqual([
      201,
      { ok: "created", page: refreshedTo("<p>undefined undefined undefined</p>") },
    ]);
  });

  it("GET の RPC には、x-rinka-page があっても、{ ok } と x-rinka-page の URL への { redirect } に page を含めない", async () => {
    expect(await Promise.all([call(ids.read, {}, "GET"), call(ids.readMoved, {}, "GET")])).toEqual([
      [200, { ok: "read" }],
      [200, { redirect: "/form?x=1" }],
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

describe("ディレクトリの middleware.ts と route.ts が投げた notFound()", () => {
  const rootNotFound = fallbackOf(fallback("root"));
  const rootError = fallbackOf(fallback("root error"));
  const adminNotFound = fallbackOf(fallback("admin"), [layout("main", "admin")]);
  const adminError = fallbackOf(fallback("admin error"), [layout("main", "admin")]);
  const parent = { notFound: rootNotFound, error: rootError };
  const routes: Routes = {
    routes: [
      pageRoute("/admin", page("admin"), [layout("main", "admin")], [guarded(hide, parent)], {
        notFound: adminNotFound,
        error: adminError,
      }),
      pageRoute(
        "/secret",
        page("secret"),
        [],
        [guarded(hide, { notFound: fallbackOf(throwing(new Error("nf"))), error: rootError })],
        { notFound: rootNotFound, error: adminError },
      ),
      pageRoute("/bare", page("bare"), [], [hide], parent),
      apiRoute(
        "/api/users",
        {
          GET: () => {
            throw notFound();
          },
        },
        [],
        parent,
      ),
      notFoundRoute("/admin", adminNotFound, [guarded(hide, parent)], adminError),
      notFoundRoute("/api", fallbackOf(fallback("api"))),
      notFoundRoute("/", rootNotFound, [], rootError),
    ],
  };
  const render = async (path: string) => {
    const response = await request(routes, path);
    return [response.status, await bodyOf(response)];
  };

  it("middleware.ts が投げたときは、そのディレクトリのレイアウトと not-found.tsx を描画せずに、親から探索した not-found.tsx を 404 で返す", async () => {
    expect(await Promise.all([render("/admin"), render("/admin/x")])).toEqual([
      [404, "<h1>root /admin</h1>"],
      [404, "<h1>root /admin/x</h1>"],
    ]);
  });

  it("middleware.ts が投げたときの not-found.tsx のシェルが投げたエラーには、親から探索した error.tsx を使用する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rendered = await render("/secret");
    error.mockRestore();
    expect(rendered).toEqual([500, "<h1>root error /secret nf</h1>"]);
  });

  it("親から探索した not-found.tsx が無ければ、URL に一致する not-found.tsx を使用せずに、Not Found のテキストの 404 にする", async () => {
    expect(await render("/bare")).toEqual([404, "Not Found"]);
  });

  it("middleware.ts が next() の後で投げたときも、ページの代わりに、親から探索した not-found.tsx を 404 で返す", async () => {
    const response = await request(
      { routes: [pageRoute("/late", page("late"), [], [guarded(late, parent), marking("x-dir")])] },
      "/late",
    );
    expect([response.status, await bodyOf(response)]).toEqual([404, "<h1>root /late</h1>"]);
  });

  it("route.ts が投げたときは、URL に一致する not-found.tsx を使用せずに、route.ts のディレクトリから探索した not-found.tsx を使用する", async () => {
    expect(await render("/api/users")).toEqual([404, "<h1>root /api/users</h1>"]);
  });
});

/** `routes` のアプリに、404.html の書き出しのリクエストを送る。 */
const exported = async (routes: Routes) => {
  const response = await createApp(routes).fetch(new Request("http://localhost/_rinka/not-found"), {
    [prerenderEnv]: "not-found",
  });
  return [response.status, await bodyOf(response), response.headers.get("x-dir")];
};

describe("404.html の書き出しのリクエスト", () => {
  it("URL に一致する行にかかわらず、URL の区切りの無い not-found.tsx を、その行の middleware.ts の後で 404 で返す", async () => {
    const slug = fallbackOf(fallback("slug"));
    const site = fallbackOf(fallback("site"));
    expect(
      await Promise.all([
        exported({
          routes: [
            pageRoute("/:slug{.+}", page("slug"), [], [deny], { notFound: slug }),
            notFoundRoute("/:slug{.+}", slug, [deny]),
            notFoundRoute("/", fallbackOf(fallback("root"))),
            notFoundRoute("/", site, [marking("x-dir")]),
          ],
        }),
        exported({ routes: [notFoundRoute("/", site, [marking("x-dir")])] }),
        exported({ routes: [pageRoute("/", page("top"))] }),
      ]),
    ).toEqual([
      [404, "<h1>root /_rinka/not-found</h1>", null],
      [404, "<h1>site /_rinka/not-found</h1>", "1"],
      [404, "Not Found", null],
    ]);
  });

  it("その行の middleware.ts が返した Response を、not-found.tsx の代わりに返す", async () => {
    const response = await createApp({
      routes: [notFoundRoute("/", fallbackOf(fallback("root")), [deny])],
    }).fetch(new Request("http://localhost/_rinka/not-found"), { [prerenderEnv]: "not-found" });
    expect([response.status, await response.text()]).toEqual([401, "denied"]);
  });
});

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

/** Context に Cookie の `page` を設定するページである。 */
const setting = () => {
  const c = getContext();
  if (c) setCookie(c, "page", "1");
  return jsx("p", { children: "page" });
};

describe("c.res を読んだ後のレスポンスの Set-Cookie", () => {
  const peeked = "src/app-res.ts#peeked";
  registerServerFn(
    peeked,
    defineServerFn(
      async (c: Context, next: Next) => {
        setCookie(c, "mw", "1");
        c.header("vary", "Cookie");
        // c.res を読むと、Hono の Context がレスポンスを保持する
        void c.res;
        await next();
      },
      () => new Response("ok", { headers: { "set-cookie": "fn=1", vary: "Accept" } }),
    ),
  );
  /** ページから直接呼び出す、ミドルウェアが c.res を読んでから 302 を返すサーバー関数である。 */
  const direct = defineServerFn(
    async (c: Context) => {
      setCookie(c, "mw", "1");
      void c.res;
      return new Response(null, {
        status: 302,
        headers: { location: "/next", "set-cookie": "moved=1" },
      });
    },
    () => "unreachable",
  );

  it("サーバー関数のミドルウェアが c.res を読んだ後に関数が返した Response の Set-Cookie と Vary を、Context のものとともに付ける", async () => {
    const response = await request({ routes: [] }, rpcPath(peeked), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect([response.headers.getSetCookie(), response.headers.get("vary")]).toEqual([
      ["mw=1; Path=/", "fn=1"],
      "Cookie, Accept",
    ]);
  });

  it("ページから直接呼び出したサーバー関数のミドルウェアが c.res を読んでも、ミドルウェアが返した Response をそのままページのレスポンスにする", async () => {
    const response = await request(
      { routes: [pageRoute("/direct", async () => direct())] },
      "/direct",
    );
    expect([response.status, response.headers.getSetCookie()]).toEqual([302, ["moved=1"]]);
  });

  it("ディレクトリの middleware.ts が next() の後で投げた notFound() の 404 には、下流の route.ts が返した Response のヘッダーを含めない", async () => {
    const response = await request(
      {
        routes: [
          apiRoute(
            "/late-route",
            {
              GET: () =>
                new Response("down", { headers: { "x-down": "1", "set-cookie": "down=1" } }),
            },
            [guarded(late, { notFound: fallbackOf(fallback("root")) })],
          ),
        ],
      },
      "/late-route",
    );
    expect([
      response.status,
      response.headers.get("x-down"),
      response.headers.getSetCookie(),
    ]).toEqual([404, null, []]);
  });

  it("ディレクトリの middleware.ts が next() の後で投げた notFound() の 404 にも、ページが Context に設定した Set-Cookie を 1 回付ける", async () => {
    const response = await request(
      {
        routes: [
          pageRoute(
            "/late-cookie",
            setting,
            [],
            [guarded(late, { notFound: fallbackOf(fallback("root")) })],
          ),
        ],
      },
      "/late-cookie",
    );
    expect([response.status, response.headers.getSetCookie()]).toEqual([404, ["page=1; Path=/"]]);
  });
});

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

  it("ページのリクエストでは、URL に一致する not-found.tsx を使用せずに、notFound() を Not Found のテキストの 404 にする", async () => {
    const response = await request(routes, "/nope", { headers: { "x-throw": "notFound" } });
    expect([response.status, await response.text()]).toEqual([404, "Not Found"]);
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
        apiRoute(
          "/api/gone",
          {
            GET: () => {
              throw notFound();
            },
          },
          [],
          { notFound: fallbackOf(fallback("missing")) },
        ),
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

  it("route.ts が投げた notFound() の not-found.tsx のシェルが投げたエラーには、route.ts の行の error.tsx を使用する", async () => {
    const routes: Routes = {
      routes: [
        apiRoute(
          "/broken/api",
          {
            GET: () => {
              throw notFound();
            },
          },
          [],
          { notFound: fallbackOf(throwing(new Error("nf"))), error: fallbackOf(fallback("error")) },
        ),
      ],
    };
    const response = await request(routes, "/broken/api");
    expect([response.status, await bodyOf(response)]).toEqual([
      500,
      "<h1>error /broken/api nf</h1>",
    ]);
  });
});

/** 読み込んだときに `log` に記録する、ファイル `file` の `value` のモジュールを読み込む関数を返す。 */
const logged = (log: string[], value: RouteComponent, file: string) =>
  Object.assign(
    async () => {
      log.push(`load ${file}`);
      return { default: value };
    },
    { file },
  );

describe("createApp のページの CSS", () => {
  it("not-found.tsx と error.tsx のページには、そのページとレイアウトのモジュールを読み込んだ後に、それらのファイルを styles に渡す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const log: string[] = [];
    const root = logged(log, layout("main", "root"), "src/routes/layout.tsx");
    const fallbacks = {
      notFound: {
        module: logged(log, page("missing"), "src/routes/not-found.tsx"),
        layouts: [root],
      },
      error: { module: logged(log, page("failed"), "src/routes/error.tsx"), layouts: [root] },
    };
    /** `component` を `file` から読み込む、`path` のページの行を返す。 */
    const thrown = (path: string, component: RouteComponent, file: string): Route => ({
      kind: "page",
      path,
      pattern: path,
      module: logged(log, component, file),
      layouts: [],
      middlewares: [],
      ...fallbacks,
    });
    const app = createApp(
      {
        routes: [
          thrown(
            "/gone",
            () => {
              throw notFound();
            },
            "src/routes/gone/page.tsx",
          ),
          thrown(
            "/broken",
            () => {
              throw new Error("broken");
            },
            "src/routes/broken/page.tsx",
          ),
          notFoundRoute("/", fallbacks.notFound, [], fallbacks.error),
        ],
      },
      {
        styles: async (files) => {
          log.push(`styles ${files.join(" ")}`);
          return files.map((file) => `/${file}.css`);
        },
      },
    );
    const results = [];
    for (const path of ["/nope", "/gone", "/broken"]) {
      log.length = 0;
      // oxlint-disable-next-line no-await-in-loop
      const response = await app.fetch(new Request(`http://localhost${path}`));
      // oxlint-disable-next-line no-await-in-loop
      const html = await response.text();
      const head = html.slice(0, html.indexOf("</head>"));
      const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
        (match) => match[1],
      );
      results.push({ path, status: response.status, links, log: [...log] });
    }
    const notFoundLinks = ["/src/routes/layout.tsx.css", "/src/routes/not-found.tsx.css"];
    const notFoundLog = [
      "load src/routes/not-found.tsx",
      "load src/routes/layout.tsx",
      "styles src/routes/layout.tsx src/routes/not-found.tsx",
    ];
    expect(results).toEqual([
      { path: "/nope", status: 404, links: notFoundLinks, log: notFoundLog },
      {
        path: "/gone",
        status: 404,
        links: notFoundLinks,
        log: ["load src/routes/gone/page.tsx", "styles src/routes/gone/page.tsx", ...notFoundLog],
      },
      {
        path: "/broken",
        status: 500,
        links: ["/src/routes/layout.tsx.css", "/src/routes/error.tsx.css"],
        log: [
          "load src/routes/broken/page.tsx",
          "styles src/routes/broken/page.tsx",
          "load src/routes/error.tsx",
          "load src/routes/layout.tsx",
          "styles src/routes/layout.tsx src/routes/error.tsx",
        ],
      },
    ]);
  });
});
