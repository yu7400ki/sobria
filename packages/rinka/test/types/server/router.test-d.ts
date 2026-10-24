import type { Context } from "hono";
import type { ServerNode } from "rinka";
import { href, type LayoutProps, type PageProps, type Prerender } from "rinka/router";
import { defineHandler, getContext, setBlockingRender } from "rinka/server";
import { describe, expectTypeOf, it } from "vitest";

declare module "rinka/router" {
  interface RouteParams {
    "/": {};
    "/users/[id]": { id: string };
    "/docs/[...slug]": { slug: string };
  }
}

describe("rinka/router", () => {
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
});

describe("rinka/server のルーティングの API", () => {
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
