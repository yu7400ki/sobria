import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRoutes } from "../../src/build/routes.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `src/routes/` の配下に `files` の空のファイルを作成し、プロジェクトのルートを返す。 */
function project(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rinka-routes-"));
  roots.push(root);
  for (const file of files) {
    const path = join(root, "src/routes", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  return root;
}

const scan = (files: readonly string[]) => scanRoutes(project(files), "src/routes");

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
      notFound: { file: "src/routes/not-found.tsx", layouts: root },
      error: { file: "src/routes/error.tsx", layouts: root },
    };
    const users = {
      layouts: [...root, "src/routes/users/layout.tsx"],
      middlewares: ["src/routes/users/middleware.ts"],
      ...fallbacks,
    };
    expect(table).toEqual({
      middleware: "src/routes/middleware.ts",
      routes: [
        {
          kind: "page",
          path: "/",
          file: "src/routes/page.tsx",
          layouts: root,
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "page",
          path: "/about",
          file: "src/routes/(marketing)/about/page.tsx",
          layouts: [...root, "src/routes/(marketing)/layout.tsx"],
          middlewares: [],
          ...fallbacks,
        },
        { kind: "page", path: "/users", file: "src/routes/users/page.tsx", ...users },
        {
          kind: "route",
          path: "/api/users",
          file: "src/routes/api/users/route.ts",
          layouts: root,
          middlewares: [],
        },
        { kind: "page", path: "/users/new", file: "src/routes/users/new/page.tsx", ...users },
        { kind: "page", path: "/users/:id", file: "src/routes/users/[id]/page.tsx", ...users },
        {
          kind: "page",
          path: "/docs/:slug{.+}",
          file: "src/routes/docs/[...slug]/page.tsx",
          layouts: root,
          middlewares: [],
          ...fallbacks,
        },
        {
          kind: "not-found",
          path: "/*",
          file: "src/routes/not-found.tsx",
          layouts: root,
          middlewares: [],
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
      ["/admin", ["src/routes/(admin)/middleware.ts"]],
    ]);
  });

  it("ルートのディレクトリが無ければ、空の表を返す", () => {
    expect(scanRoutes(project([]), "src/routes")).toEqual({ routes: [] });
  });

  it("同じディレクトリに page.tsx と route.ts があれば、エラーを投げる", () => {
    expect(() => scan(["users/page.tsx", "users/route.ts"])).toThrow("src/routes/users");
  });

  it("グループを経由して 2 つのファイルが同じ URL を扱うなら、両方のファイルを示すエラーを投げる", () => {
    expect(() => scan(["(a)/about/page.tsx", "(b)/about/page.tsx"])).toThrow(
      /src\/routes\/\(a\)\/about\/page\.tsx.*src\/routes\/\(b\)\/about\/page\.tsx|src\/routes\/\(b\)\/about\/page\.tsx.*src\/routes\/\(a\)\/about\/page\.tsx/,
    );
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

  it("キャッチオールの配下のディレクトリにあるルートのファイルは、エラーにする", () => {
    expect(() => scan(["docs/[...slug]/page.tsx", "docs/[...slug]/foo/page.tsx"])).toThrow(
      "src/routes/docs/[...slug]/foo/page.tsx",
    );
    expect(scan(["docs/[...slug]/page.tsx", "docs/[...slug]/parts/toc.tsx"]).routes).toHaveLength(
      1,
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
    const root = { file: "src/routes/error.tsx", layouts: [] };
    const shop = { file: "src/routes/(shop)/error.tsx", layouts: ["src/routes/(shop)/layout.tsx"] };
    expect(
      routes.map(({ file, notFound, error }) => ({ file, notFound: notFound?.file, error })),
    ).toEqual([
      {
        file: "src/routes/about/page.tsx",
        notFound: "src/routes/about/not-found.tsx",
        error: root,
      },
      {
        file: "src/routes/(shop)/cart/page.tsx",
        notFound: "src/routes/not-found.tsx",
        error: shop,
      },
      {
        file: "src/routes/about/not-found.tsx",
        notFound: undefined,
        error: root,
      },
      { file: "src/routes/not-found.tsx", notFound: undefined, error: root },
    ]);
  });

  it("not-found.tsx は、ページと route.ts の後に、深い順に並べ、同じ URL ならグループの外のものを先に並べる。route.ts にはエラーのページを付けない", () => {
    const { routes } = scan([
      "(a)/not-found.tsx",
      "(a)/x/not-found.tsx",
      "x/not-found.tsx",
      "error.tsx",
      "api/route.ts",
    ]);
    expect(routes.map((route) => [route.file, route.path, "error" in route])).toEqual([
      ["src/routes/api/route.ts", "/api", false],
      ["src/routes/x/not-found.tsx", "/x/*", true],
      ["src/routes/(a)/x/not-found.tsx", "/x/*", true],
      ["src/routes/(a)/not-found.tsx", "/*", true],
    ]);
  });
});
