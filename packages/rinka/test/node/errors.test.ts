import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { NotFound, notFound, Redirect, redirect } from "../../src/server/errors.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse } from "../../src/server/response.ts";
import { readText } from "./stream-order.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** `value` を投げる async のコンポーネントを作成する。 */
const throwing = (value: unknown) => async () => {
  await Promise.resolve();
  throw value;
};

/** 外から解決できる async のコンポーネントを作成する。解決すると `value` を投げる。 */
function deferredThrow(value: unknown) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const Slow = async () => {
    await promise;
    throw value;
  };
  return { Slow, resolve };
}

/** `value` を投げる async のコンポーネントを、Errored で囲む。 */
const wrap = (value: unknown) =>
  jsx(Errored, { fallback: "x", children: jsx(throwing(value), {}) });

const Sync = () => {
  throw new Error("e");
};

/** `value` を同期的に投げるコンポーネントを Errored で囲み、保留中でない Loading で囲む。 */
const slottedErrored = (value: unknown) =>
  jsx(Loading, {
    fallback: "w",
    children: jsx(Errored, {
      fallback: "x",
      children: jsx(() => {
        throw value;
      }, {}),
    }),
  });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("シェルの中", () => {
  it("redirect() は、デフォルトで 303 の、指定したステータスのリダイレクトにする", async () => {
    const seeOther = await renderToResponse(jsx(throwing(redirect("/login")), {}));
    expect(seeOther.status).toBe(303);
    expect(seeOther.headers.get("location")).toBe("/login");
    const moved = await renderToResponse(jsx(throwing(redirect("/new", 301)), {}));
    expect(moved.status).toBe(301);
  });

  it("notFound() は、notFound のページを 404 で返す", async () => {
    const response = await renderToResponse(jsx(throwing(notFound()), {}), {
      notFound: () => jsx("h1", { children: "無い" }),
    });
    expect(response.status).toBe(404);
    expect(await readText(response)).toContain("<body><h1>無い</h1></body>");
    expect((await renderToResponse(jsx(throwing(notFound()), {}))).status).toBe(404);
  });

  it("受け止められなかったエラーは、エラーを受け取った error のページを 500 で返す", async () => {
    const response = await renderToResponse(jsx(throwing(new Error("壊れた")), {}), {
      error: (error) => jsx("h1", { children: error instanceof Error ? error.message : "" }),
    });
    expect(response.status).toBe(500);
    expect(await readText(response)).toContain("<body><h1>壊れた</h1></body>");
  });

  it("投げた Response は、そのままレスポンスにする", async () => {
    const thrown = new Response("要ログイン", { status: 401 });
    expect(await renderToResponse(jsx(throwing(thrown), {}))).toBe(thrown);
  });

  it("Errored が受け止めると、ステータスを 500 か、status に指定した値にする", async () => {
    const failing = jsx(Errored, { fallback: "x", children: jsx(throwing(new Error("e")), {}) });
    const response = await renderToResponse(failing);
    expect(response.status).toBe(500);
    expect(await readText(response)).toContain("<body>x</body>");
    const ok = jsx(Errored, {
      fallback: "x",
      status: 200,
      children: jsx(throwing(new Error("e")), {}),
    });
    expect((await renderToResponse(ok)).status).toBe(200);
  });

  it("Errored は、redirect() と notFound() と Response を受け止めない", async () => {
    expect((await renderToResponse(wrap(redirect("/a")))).status).toBe(303);
    expect((await renderToResponse(wrap(notFound()))).status).toBe(404);
    expect((await renderToResponse(wrap(new Response(null, { status: 401 })))).status).toBe(401);
  });

  it("投げた HTTPException は、getResponse() の Response として扱い、Errored は受け止めない", async () => {
    const res = new Response(null, { status: 401, headers: { "www-authenticate": "Basic" } });
    const response = await renderToResponse(wrap(new HTTPException(401, { res })));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Basic");
    const login = new Response(null, { status: 302, headers: { location: "/login" } });
    const moved = await renderToResponse(jsx(throwing(new HTTPException(302, { res: login })), {}));
    expect(moved.headers.get("location")).toBe("/login");
  });

  it("保留中でない Loading の中で受け止めたエラーは、シェルの中として扱う", async () => {
    const response = await renderToResponse(
      jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback: "x", children: jsx(Sync, {}) }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await readText(response)).toContain("<body>x</body>");
  });
});

describe("シェルの中の判定", () => {
  it("同期的に投げたエラーは、兄弟の順序に関わらずシェルの中で受け止める", async () => {
    const orders = [
      [jsx(throwing("late"), {}), jsx(Sync, {})],
      [jsx(Sync, {}), jsx(throwing("late"), {})],
    ];
    for (const children of orders) {
      const inner = jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback: "x", children }),
      });
      const outer = jsx(Errored, {
        fallback: "x",
        children: jsx(Loading, { fallback: "wait", children }),
      });
      for (const node of [inner, outer]) {
        // oxlint-disable-next-line no-await-in-loop
        const response = await renderToResponse(node);
        expect(response.status).toBe(500);
        // oxlint-disable-next-line no-await-in-loop
        expect(await readText(response)).toContain("<body>x</body>");
      }
    }
  });

  it("後送りの境界の <slot> に配置した内容の中の Errored も、シェルの中として扱う", async () => {
    const slow = deferredThrow(undefined);
    const Frame = defineElement(
      "x-err-frame",
      () => jsx(Loading, { fallback: "f", children: [jsx(slow.Slow, {}), jsx("slot", {})] }),
      { props: ["children"] },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const caught = renderToResponse(jsx(Frame, { children: slottedErrored(new Error("e")) }));
    slow.resolve();
    expect((await caught).status).toBe(500);
    const missing = await renderToResponse(jsx(Frame, { children: slottedErrored(notFound()) }));
    expect(missing.status).toBe(404);
  });

  it("複数の Errored が受け止めたら、大きいほうのステータスにする", async () => {
    const response = await renderToResponse([
      jsx(Errored, { fallback: "a", status: 403, children: jsx(Sync, {}) }),
      jsx(Errored, { fallback: "b", children: jsx(Sync, {}) }),
    ]);
    expect(response.status).toBe(500);
  });

  it("入れ子の Errored は、内側が通過させた値を受け止めない", async () => {
    const response = await renderToResponse(
      jsx(Errored, { fallback: "o", children: wrap(redirect("/a")) }),
    );
    expect(response.status).toBe(303);
  });

  it("error のページが無ければ、受け止められなかったエラーで reject する", async () => {
    await expect(renderToResponse(jsx(throwing(new Error("壊れた")), {}))).rejects.toThrow(
      "壊れた",
    );
  });

  it("redirect() は、相対 URL と http と https 以外の移動先をエラーにする", () => {
    expect(() => redirect("javascript:alert(1)")).toThrow("相対 URL か");
    expect(() => redirect(" java	script:alert(1)")).toThrow("相対 URL か");
    expect(redirect("https://example.com/").location).toBe("https://example.com/");
    expect(redirect("/a?b=c:d").location).toBe("/a?b=c:d");
  });

  it("Redirect を直接作成しても、相対 URL と http と https 以外の移動先をエラーにする", () => {
    expect(() => new Redirect("javascript:alert(1)", 303)).toThrow("相対 URL か");
  });
});

describe("シェルの後", () => {
  it("redirect() は、location.replace と meta refresh で移動させ、フォールバックを残す", async () => {
    const { Slow, resolve } = deferredThrow(redirect("/login"));
    const responding = renderToResponse(
      jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback: "x", children: jsx(Slow, {}) }),
      }),
    );
    const response = await responding;
    resolve();
    const html = await readText(response);
    expect(response.status).toBe(200);
    expect(html).toContain(
      '<script>location.replace("/login")</script><meta http-equiv="refresh" content="0;url=/login">',
    );
    expect(html).not.toContain("<template data-os");
    expect(html).not.toContain(">x<");
    expect(html).toContain('<template data-ob="b1"></template>wait<!--/ob:b1-->');
  });

  it("3xx の Response は移動させ、3xx 以外の Response は Errored が受け止める", async () => {
    const moved = deferredThrow(
      new Response(null, { status: 302, headers: { location: "/next" } }),
    );
    const denied = deferredThrow(new Response(null, { status: 401 }));
    const response = await renderToResponse([
      jsx(Loading, { fallback: "a", children: jsx(moved.Slow, {}) }),
      jsx(Loading, {
        fallback: "b",
        children: jsx(Errored, { fallback: "拒否", children: jsx(denied.Slow, {}) }),
      }),
    ]);
    moved.resolve();
    denied.resolve();
    const html = await readText(response);
    expect(html).toContain('<script>location.replace("/next")</script>');
    expect(html).toContain('<template data-os="b2">拒否</template>');
  });

  it("移動先が相対 URL でも http や https でもない 3xx の Response は、移動させずに記録する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unsafe = deferredThrow(
      new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } }),
    );
    const response = await renderToResponse(
      jsx(Loading, { fallback: "wait", children: jsx(unsafe.Slow, {}) }),
    );
    unsafe.resolve();
    const html = await readText(response);
    expect(html).not.toContain("location.replace");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("移動先が規則に合わない 3xx の Response は、Errored が受け止める", async () => {
    const unsafe = deferredThrow(
      new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } }),
    );
    const response = await renderToResponse(
      jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback: "caught", children: jsx(unsafe.Slow, {}) }),
      }),
    );
    unsafe.resolve();
    expect(await readText(response)).toContain('<template data-os="b1">caught</template>');
  });

  it("Errored がフォールバックに切り替えた領域の中の境界は、移動させない", async () => {
    const moving = deferredThrow(redirect("/r"));
    const failing = deferredThrow(new Error("e"));
    const responding = renderToResponse(
      jsx(Errored, {
        fallback: "EB",
        children: [
          jsx(Loading, { fallback: "wait", children: jsx(moving.Slow, {}) }),
          jsx(failing.Slow, {}),
        ],
      }),
    );
    await tick();
    failing.resolve();
    const response = await responding;
    expect(response.status).toBe(500);
    moving.resolve();
    const html = await readText(response);
    expect(html).not.toContain("location.replace");
  });

  it("notFound() は Errored が受け止め、noindex を 1 回だけ出力する", async () => {
    const first = deferredThrow(notFound());
    const second = deferredThrow(notFound());
    const seen: unknown[] = [];
    const fallback = (error: unknown) => {
      seen.push(error);
      return "無い";
    };
    const region = (Slow: () => Promise<never>) =>
      jsx(Loading, {
        fallback: "wait",
        children: jsx(Errored, { fallback, children: jsx(Slow, {}) }),
      });
    const response = await renderToResponse([region(first.Slow), region(second.Slow)]);
    first.resolve();
    await tick();
    second.resolve();
    const html = await readText(response);
    expect(seen.length).toBe(2);
    expect(seen.every((error) => error instanceof NotFound)).toBe(true);
    expect(html.split('<meta name="robots" content="noindex">').length).toBe(2);
    expect(html).toContain('<template data-os="b1">無い</template>');
  });

  it("受け止められなかった失敗は、フォールバックを残して記録し、残りの部分を送り続ける", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deferredThrow(new Error("e"));
    const { promise, resolve } = Promise.withResolvers<void>();
    const Later = async () => {
      await promise;
      return "後";
    };
    const response = await renderToResponse([
      jsx(Loading, { fallback: "wait", children: jsx(failing.Slow, {}) }),
      jsx(Loading, { fallback: "…", children: jsx(Later, {}) }),
    ]);
    failing.resolve();
    await tick();
    resolve();
    const html = await readText(response);
    expect(response.status).toBe(200);
    expect(html).not.toContain('data-os="b1"');
    expect(html).toContain('<template data-os="b2">後</template>');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
