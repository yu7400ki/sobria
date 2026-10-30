import type { Context } from "hono";
import type { ServerNode } from "sobria";
import {
  href,
  type ErrorProps,
  type LayoutProps,
  type NotFoundProps,
  type PageProps,
  type Prerender,
} from "sobria/router";
import {
  defineHandler,
  defineMiddleware,
  forRoute,
  getContext,
  setBlockingRender,
} from "sobria/server";
import { describe, expectTypeOf, it } from "vitest";

declare module "sobria/router" {
  interface RouteParams {
    "/": {};
    "/users/[id]": { id: string };
    "/docs/[...slug]": { slug: string };
    "/api/[model]/[id]": { model: string; id: string };
    "/files/[...path]": { path: string };
  }
  interface RouteHandlerPaths {
    "/api/[model]/[id]": "/api/:model/:id";
    "/files/[...path]": "/files/:path{.+}";
  }
}

describe("sobria/router", () => {
  it("PageProps は、RouteParams の値の型の params と、url を持つ", () => {
    expectTypeOf<PageProps<"/users/[id]">>().toEqualTypeOf<{
      readonly params: { id: string };
      readonly url: URL;
    }>();
  });

  it("LayoutProps は、文字列の params と、url と、children を持つ", () => {
    expectTypeOf<LayoutProps["params"]>().toEqualTypeOf<Readonly<Record<string, string>>>();
    expectTypeOf<LayoutProps["children"]>().toEqualTypeOf<ServerNode>();
  });

  it("NotFoundProps は文字列の params と url を持ち、ErrorProps はさらに投げられた値の error を持つ", () => {
    expectTypeOf<NotFoundProps>().toEqualTypeOf<{
      readonly params: Readonly<Record<string, string>>;
      readonly url: URL;
    }>();
    expectTypeOf<ErrorProps>().toEqualTypeOf<{
      readonly params: Readonly<Record<string, string>>;
      readonly url: URL;
      readonly error: unknown;
    }>();
  });

  it("href は、パラメータのあるルートでは、過不足の無いパラメータを要求する", () => {
    expectTypeOf(href("/users/[id]", { id: 3 })).toBeString();
    href("/", undefined, { page: 2 });
    href("/");
    // @ts-expect-error RouteParams に無いルートである
    href("/missing");
    // @ts-expect-error パラメータが不足している
    href("/users/[id]");
    // @ts-expect-error パラメータが不足している
    href("/users/[id]", {});
    // @ts-expect-error ルートに無い名前のパラメータである
    href("/users/[id]", { id: 1, extra: 2 });
    const either = "/users/[id]" as "/" | "/users/[id]";
    // @ts-expect-error ルートがユニオンだと、パラメータが必要かどうかが決まらない
    href(either);
  });

  it("Prerender は、パラメータの無いルートでは true、パラメータのあるルートではパラメータの配列を返す関数である", () => {
    expectTypeOf<Prerender<"/">>().toEqualTypeOf<true>();
    type Users = { readonly id: string | number };
    expectTypeOf<Prerender<"/users/[id]">>().toEqualTypeOf<
      () => readonly Users[] | Promise<readonly Users[]>
    >();
  });

  it("Prerender は、パラメータのある route.ts のルートでは never である", () => {
    expectTypeOf<Prerender<"/api/[model]/[id]">>().toEqualTypeOf<never>();
  });

  it("PageProps は、route.ts のルートを受け付けない", () => {
    // @ts-expect-error route.ts のルートである
    expectTypeOf<PageProps<"/api/[model]/[id]">>();
  });
});

describe("sobria/server のルーティングの API", () => {
  it("getContext は、Hono の Context か undefined を返す", () => {
    expectTypeOf(getContext).returns.toEqualTypeOf<Context | undefined>();
  });

  it("setBlockingRender は、Hono の Context と真偽値を受け取る", () => {
    expectTypeOf(setBlockingRender).parameters.toEqualTypeOf<[Context, boolean]>();
  });

  it("defineHandler は、hono/factory の defineHandler である", () => {
    expectTypeOf(defineHandler).toEqualTypeOf<typeof import("hono/factory").defineHandler>();
  });
});

describe("forRoute", () => {
  it("defineHandler の c.req.param() は、ルートのパラメータを string で返す", () => {
    forRoute("/api/[model]/[id]").defineHandler((c) => {
      expectTypeOf(c.req.param("model")).toEqualTypeOf<string>();
      expectTypeOf(c.req.param()).toEqualTypeOf<{ model: string; id: string }>();
      expectTypeOf(c.req.param("slug")).toEqualTypeOf<string | undefined>();
      return null;
    });
  });

  it("キャッチオールのパラメータも string で返す", () => {
    forRoute("/files/[...path]").defineHandler((c) => {
      expectTypeOf(c.req.param("path")).toEqualTypeOf<string>();
      return null;
    });
  });

  it("先に渡したミドルウェアの変数と、ルートのパラメータの両方に型が付く", () => {
    const auth = defineMiddleware<{ Variables: { user: string } }>(async (_c, next) => {
      await next();
    });
    forRoute("/api/[model]/[id]").defineHandler(auth, (c) => {
      expectTypeOf(c.get("user")).toEqualTypeOf<string>();
      expectTypeOf(c.req.param("id")).toEqualTypeOf<string>();
      return null;
    });
  });

  it("検証のある defineHandler でも、ルートのパラメータに型が付く", () => {
    forRoute("/api/[model]/[id]").defineHandler({
      query: (value) => ({ page: Number(value["page"]) }),
    })((c, { query }) => {
      expectTypeOf(c.req.param("model")).toEqualTypeOf<string>();
      expectTypeOf(query).toEqualTypeOf<{ page: number }>();
      return null;
    });
  });

  it("RouteHandlerPaths に無いルートと、ページのルートは受け付けない", () => {
    // @ts-expect-error RouteHandlerPaths に無いルート
    forRoute("/missing");
    // @ts-expect-error ページのルート
    forRoute("/users/[id]");
  });
});
