import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { routesModule, scanRoutes, type PathFiles } from "../../src/build/routes.ts";
import {
  mapRouteFiles,
  type Route,
  type RouteFiles,
  type Routes,
} from "../../src/shared/routes.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `src/routes/` の配下に `files` の空のファイルを作成し、プロジェクトのルートを返す。 */
function project(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "sobria-routes-"));
  roots.push(root);
  for (const file of files) {
    const path = join(root, "src/routes", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  return root;
}

/** `files` を配置したプロジェクトを、登録した拡張子 `extensions` で走査する。 */
const scan = (files: readonly string[], extensions: readonly string[] = []) =>
  scanRoutes(project(files), extensions);

/** 行のモジュールのファイルを返す。`not-found.tsx` の行では、その `not-found.tsx` のファイルを返す。 */
const moduleOf = (route: Route<PathFiles>): string =>
  route.kind === "not-found" ? route.notFound.module : route.module;

/** `(a)/users/[inner]` と `users/[outer]` の not-found.tsx を走査し、並んだファイルを返す。 */
const nestedNotFounds = (inner: string, outer: string) =>
  scan([`(a)/users/[${inner}]/not-found.tsx`, `users/[${outer}]/not-found.tsx`]).routes.map(
    moduleOf,
  );

describe("scanRoutes", () => {
  it("特別な名前のファイルを、レイアウトとミドルウェアとともに、静的な区切り、動的な区切り、キャッチオールの順に列挙する", () => {
    const table = scan([
      "layout.tsx",
      "page.tsx",
      "middleware.ts",
      "not-found.tsx",
      "error.tsx",
      "users/layout.tsx",
      "users/page.tsx",
      "users/middleware.ts",
      "users/[id]/page.tsx",
      "users/[id]/user-header.tsx",
      "users/new/page.tsx",
      "api/users/route.ts",
      "(marketing)/layout.tsx",
      "(marketing)/about/page.tsx",
      "docs/[...slug]/page.tsx",
    ]);
    const root = ["src/routes/layout.tsx"];
    const fallbacks = {
      notFound: { module: "src/routes/not-found.tsx", layouts: root },
      error: { module: "src/routes/error.tsx", layouts: root },
    };
    const users = {
      layouts: [...root, "src/routes/users/layout.tsx"],
      middlewares: [{ module: "src/routes/users/middleware.ts", ...fallbacks }],
      ...fallbacks,
    };
    expect(table).toEqual({
      middleware: "src/routes/middleware.ts",
      routes: [
        {
          kind: "page",
          path: "/",
          pattern: "/",
          module: "src/routes/page.tsx",
          layouts: root,
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "page",
          path: "/about",
          pattern: "/about",
          module: "src/routes/(marketing)/about/page.tsx",
          layouts: [...root, "src/routes/(marketing)/layout.tsx"],
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "page",
          path: "/users",
          pattern: "/users",
          module: "src/routes/users/page.tsx",
          ...users,
        },
        {
          kind: "route",
          path: "/api/users",
          pattern: "/api/users",
          module: "src/routes/api/users/route.ts",
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "page",
          path: "/users/new",
          pattern: "/users/new",
          module: "src/routes/users/new/page.tsx",
          ...users,
        },
        {
          kind: "page",
          path: "/users/:id",
          pattern: "/users/[id]",
          module: "src/routes/users/[id]/page.tsx",
          ...users,
        },
        {
          kind: "page",
          path: "/docs/:slug{.+}",
          pattern: "/docs/[...slug]",
          module: "src/routes/docs/[...slug]/page.tsx",
          layouts: root,
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "not-found",
          path: "/*",
          middlewares: [],
          notFound: { module: "src/routes/not-found.tsx", layouts: root },
          error: fallbacks.error,
        },
      ],
    });
  });

  it("グループの中の middleware.ts は、そのグループのルートだけに適用する", () => {
    const { routes, middleware } = scan([
      "(admin)/middleware.ts",
      "(admin)/admin/page.tsx",
      "about/page.tsx",
    ]);
    expect(middleware).toBeUndefined();
    expect(routes.map((route) => [route.path, route.middlewares])).toEqual([
      ["/about", []],
      ["/admin", [{ module: "src/routes/(admin)/middleware.ts" }]],
    ]);
  });

  it("middleware.ts には親のディレクトリから、route.ts にはそのディレクトリから探索した not-found.tsx と error.tsx を付ける", () => {
    const { routes } = scan([
      "not-found.tsx",
      "(shop)/error.tsx",
      "(shop)/middleware.ts",
      "(shop)/not-found.tsx",
      "(shop)/cart/middleware.ts",
      "(shop)/cart/page.tsx",
      "(shop)/cart/api/route.ts",
    ]);
    const root = { notFound: { module: "src/routes/not-found.tsx", layouts: [] } };
    const shop = {
      notFound: { module: "src/routes/(shop)/not-found.tsx", layouts: [] },
      error: { module: "src/routes/(shop)/error.tsx", layouts: [] },
    };
    const middlewares = [
      { module: "src/routes/(shop)/middleware.ts", ...root },
      { module: "src/routes/(shop)/cart/middleware.ts", ...shop },
    ];
    expect(
      routes.flatMap((route) =>
        route.kind === "route"
          ? [[route.path, route.middlewares, route.notFound, route.error]]
          : [],
      ),
    ).toEqual([["/cart/api", middlewares, shop.notFound, shop.error]]);
    expect(routes.find((route) => route.kind === "page")?.middlewares).toEqual(middlewares);
  });

  it("ルートのディレクトリが無ければ、空の表を返す", () => {
    expect(scanRoutes(project([]), [])).toEqual({ routes: [] });
  });

  it("同じディレクトリに page.tsx と route.ts があれば、エラーを投げる", () => {
    expect(() => scan(["users/page.tsx", "users/route.ts"])).toThrow("src/routes/users");
  });

  it("グループを経由して 2 つのファイルが同じ URL を扱うなら、両方のファイルを示すエラーを投げる", () => {
    expect(() => scan(["(a)/about/page.tsx", "(b)/about/page.tsx"])).toThrow(
      /src\/routes\/\(a\)\/about\/page\.tsx.*src\/routes\/\(b\)\/about\/page\.tsx|src\/routes\/\(b\)\/about\/page\.tsx.*src\/routes\/\(a\)\/about\/page\.tsx/,
    );
  });

  it("静的な区切りは、名前が param や catch-all でも、動的な区切りやキャッチオールと別の URL とみなす", () => {
    expect(scan(["param/page.tsx", "[id]/page.tsx"]).routes.map((route) => route.path)).toEqual([
      "/param",
      "/:id",
    ]);
    expect(
      scan(["catch-all/page.tsx", "[...slug]/page.tsx"]).routes.map((route) => route.path),
    ).toEqual(["/catch-all", "/:slug{.+}"]);
  });

  it("同じ位置の動的な区切りは、名前が異なっても同じ URL を扱うとみなす", () => {
    expect(() => scan(["users/[id]/page.tsx", "users/[slug]/page.tsx"])).toThrow("/users/");
    expect(() => scan(["docs/[...a]/page.tsx", "docs/[...b]/route.ts"])).toThrow("/docs/");
  });
});

describe("scanRoutes が拒否する構成", () => {
  it("[ か ( で始まり、動的な区切り、キャッチオール、グループのどれでもない名前は、エラーにする", () => {
    for (const dir of ["[user-id]", "[[...opt]]", "()"]) {
      expect(() => scan([`${dir}/page.tsx`])).toThrow(`src/routes/${dir}`);
    }
  });

  it("同じ URL を扱い、ディレクトリの深さが同じ 2 つの not-found.tsx は、エラーにする", () => {
    expect(() => scan(["users/[id]/not-found.tsx", "users/[slug]/not-found.tsx"])).toThrow(
      "src/routes/users/[slug]/not-found.tsx",
    );
    expect(() => scan(["(a)/x/not-found.tsx", "(b)/x/not-found.tsx"])).toThrow(
      "src/routes/(b)/x/not-found.tsx",
    );
  });

  it("キャッチオールの配下のディレクトリにあるルートのファイルは、エラーにする", () => {
    expect(() => scan(["docs/[...slug]/page.tsx", "docs/[...slug]/foo/page.tsx"])).toThrow(
      "src/routes/docs/[...slug]/foo/page.tsx",
    );
    expect(scan(["docs/[...slug]/page.tsx", "docs/[...slug]/parts/toc.tsx"]).routes).toHaveLength(
      1,
    );
  });
});

describe("登録した拡張子のルートのファイル", () => {
  it("page、layout、error、not-found には登録した拡張子を使用でき、route と middleware には使用できない", () => {
    const files = [
      "layout.page",
      "page.page",
      "error.page",
      "not-found.page",
      "middleware.page",
      "users/page.tsx",
      "api/route.page",
    ];
    const table = scan(files, [".page"]);
    expect(table.middleware).toBeUndefined();
    expect(table.routes.map(moduleOf)).toEqual([
      "src/routes/page.page",
      "src/routes/users/page.tsx",
      "src/routes/not-found.page",
    ]);
    expect(table.routes[0]).toMatchObject({
      layouts: ["src/routes/layout.page"],
      notFound: { module: "src/routes/not-found.page" },
      error: { module: "src/routes/error.page" },
    });
    expect(scan(files).routes.map(moduleOf)).toEqual(["src/routes/users/page.tsx"]);
  });

  it("同じディレクトリに、拡張子を除いた名前が同じルートのファイルが 2 つあると、エラーにする", () => {
    expect(() => scan(["page.tsx", "page.page"], [".page"])).toThrow(
      "src/routes/page.page と src/routes/page.tsx",
    );
    expect(() => scan(["users/layout.page", "users/layout.tsx"], [".page"])).toThrow(
      "src/routes/users/layout.page と src/routes/users/layout.tsx",
    );
  });
});

describe("scanRoutes のエラーのページ", () => {
  it("ページには not-found.tsx と error.tsx を、not-found.tsx には error.tsx を、グループを含めてそのディレクトリか祖先のディレクトリで最も近いものから、そのレイアウトとともに付ける", () => {
    const { routes } = scan([
      "not-found.tsx",
      "error.tsx",
      "(shop)/layout.tsx",
      "(shop)/error.tsx",
      "(shop)/cart/page.tsx",
      "about/page.tsx",
      "about/not-found.tsx",
    ]);
    const root = { module: "src/routes/error.tsx", layouts: [] };
    const shop = {
      module: "src/routes/(shop)/error.tsx",
      layouts: ["src/routes/(shop)/layout.tsx"],
    };
    expect(
      routes.map((route) => ({
        module: moduleOf(route),
        notFound: route.kind === "page" ? route.notFound?.module : undefined,
        error: route.kind === "route" ? undefined : route.error,
      })),
    ).toEqual([
      {
        module: "src/routes/about/page.tsx",
        notFound: "src/routes/about/not-found.tsx",
        error: root,
      },
      {
        module: "src/routes/(shop)/cart/page.tsx",
        notFound: "src/routes/not-found.tsx",
        error: shop,
      },
      {
        module: "src/routes/about/not-found.tsx",
        notFound: undefined,
        error: root,
      },
      { module: "src/routes/not-found.tsx", notFound: undefined, error: root },
    ]);
  });

  it("同じ URL を扱い、ディレクトリの深さが違う not-found.tsx は、パラメータの名前にかかわらず、浅いほうを先に並べる", () => {
    expect(nestedNotFounds("id", "slug")).toEqual([
      "src/routes/users/[slug]/not-found.tsx",
      "src/routes/(a)/users/[id]/not-found.tsx",
    ]);
    expect(nestedNotFounds("slug", "id")).toEqual([
      "src/routes/users/[id]/not-found.tsx",
      "src/routes/(a)/users/[slug]/not-found.tsx",
    ]);
  });

  it("not-found.tsx は、ページと route.ts の後に、深い順に並べ、同じ URL ならグループの外のものを先に並べる", () => {
    const { routes } = scan([
      "(a)/not-found.tsx",
      "(a)/x/not-found.tsx",
      "x/not-found.tsx",
      "error.tsx",
      "api/route.ts",
    ]);
    expect(routes.map((route) => [moduleOf(route), route.path, "error" in route])).toEqual([
      ["src/routes/api/route.ts", "/api", true],
      ["src/routes/x/not-found.tsx", "/x/*", true],
      ["src/routes/(a)/x/not-found.tsx", "/x/*", true],
      ["src/routes/(a)/not-found.tsx", "/*", true],
    ]);
  });
});

/** モジュールを読み込む関数のコードから、読み込むファイルのパスを取り出す。 */
const importedFile = (load: unknown): string => {
  const file =
    typeof load === "function" ? /import\("\/(.*)"\)/.exec(String(load))?.[1] : undefined;
  if (file === undefined)
    throw new Error(`モジュールを読み込む関数ではありません: ${String(load)}`);
  return file;
};

describe("routesModule", () => {
  it("走査した表のすべてのファイルを、そのファイルを読み込む関数にした表を export する", () => {
    const root = project([
      "layout.tsx",
      "page.tsx",
      "middleware.ts",
      "not-found.tsx",
      "error.tsx",
      "users/middleware.ts",
      "users/[id]/page.tsx",
      "api/route.ts",
    ]);
    const code = routesModule(root, []);
    // oxlint-disable-next-line typescript/no-implied-eval
    const evaluate = new Function(
      `${code.replaceAll("export const ", "const ")}\nreturn { routes, middleware };`,
    );
    const table = evaluate() as Routes<RouteFiles>;
    expect(
      mapRouteFiles(table, {
        component: importedFile,
        middleware: importedFile,
        handlers: importedFile,
      }),
    ).toEqual(scanRoutes(root, []));
  });
});
