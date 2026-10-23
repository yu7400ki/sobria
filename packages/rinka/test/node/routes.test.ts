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
    const users = {
      layouts: [...root, "src/routes/users/layout.tsx"],
      middlewares: ["src/routes/users/middleware.ts"],
    };
    expect(table).toEqual({
      middleware: "src/routes/middleware.ts",
      routes: [
        { kind: "page", path: "/", file: "src/routes/page.tsx", layouts: root, middlewares: [] },
        {
          kind: "not-found",
          path: "/",
          file: "src/routes/not-found.tsx",
          layouts: root,
          middlewares: [],
        },
        { kind: "error", path: "/", file: "src/routes/error.tsx", layouts: root, middlewares: [] },
        {
          kind: "page",
          path: "/about",
          file: "src/routes/(marketing)/about/page.tsx",
          layouts: [...root, "src/routes/(marketing)/layout.tsx"],
          middlewares: [],
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
      ["/admin", ["src/routes/(admin)/middleware.ts"]],
      ["/about", []],
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
