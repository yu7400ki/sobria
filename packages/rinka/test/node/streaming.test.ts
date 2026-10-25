import { createRoot } from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isBot } from "../../src/server/bots.ts";
import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToStream } from "../../src/server/response.ts";
import { memo } from "../../src/shared/signals.ts";
import { checkOrder, read, readText } from "./stream-order.ts";

/** 外から解決できる async のコンポーネントを作成する。 */
function deferred(content: unknown) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const Slow = async () => {
    await promise;
    return content;
  };
  return { Slow, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("シェルと後送り", () => {
  it("保留中の Loading は、フォールバックを目印で囲んで送り、中身を後から送る", async () => {
    const { Slow, resolve } = deferred(jsx("b", { children: "done" }));
    const stream = renderToStream(
      jsx("main", { children: jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) }) }),
    );
    const reading = read(stream);
    await tick();
    resolve();
    const chunks = await reading;
    const html = chunks.join("");
    expect(chunks[0]).toContain('<main><template data-ob="b1"></template>wait<!--/ob:b1--></main>');
    expect(chunks[0]).toContain("window.$rinka");
    expect(html).toContain(
      '<template data-os="b1"><b>done</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[]})</script>',
    );
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("保留中でない Loading は、フォールバックを出力せずに中身を埋め込み、起動スクリプトを出力しない", async () => {
    const html = (
      await read(
        renderToStream(jsx(Loading, { fallback: "wait", children: jsx("b", { children: "now" }) })),
      )
    ).join("");
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><b>now</b></body></html>',
    );
  });

  it("入れ子の境界は、親の境界を送った後に送る", async () => {
    const inner = deferred("in");
    const outer = deferred(jsx(Loading, { fallback: "i", children: jsx(inner.Slow, {}) }));
    const reading = read(
      renderToStream(jsx(Loading, { fallback: "o", children: jsx(outer.Slow, {}) })),
    );
    await tick();
    inner.resolve();
    await tick();
    outer.resolve();
    const html = (await reading).join("");
    const outerAt = html.indexOf('<template data-os="b1">');
    const innerAt = html.indexOf('<template data-os="b2">');
    expect(outerAt).toBeGreaterThan(0);
    expect(innerAt).toBeGreaterThan(outerAt);
  });

  it("blocking では、すべての境界を待って、フォールバックと差し替えを含まない HTML を送る", async () => {
    const { Slow, resolve } = deferred("done");
    const reading = read(
      renderToStream(jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) }), {
        blocking: true,
      }),
    );
    await tick();
    resolve();
    const html = (await reading).join("");
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>done</body></html>',
    );
  });
});

describe("要素の中の境界", () => {
  it("要素の中の境界は、ホストの ID の列で差し替える先を示し、ホストは data-om で境界の完了を待つ", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const Card = defineElement(
      "x-card",
      () => {
        const value = memo(() => promise);
        return jsx(Loading, { fallback: "wait", children: jsx("b", { children: () => value() }) });
      },
      { props: {} },
    );
    const reading = read(renderToStream(jsx(Card, {})));
    await tick();
    resolve("v");
    const html = (await reading).join("");
    expect(html).toContain(
      '<x-card data-oh="h1" data-om="@b"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template></x-card>',
    );
    expect(html).toContain(
      '<template data-os="b2"><b>v</b></template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[]})</script><script>$rinka.d("h1",{"@b":1})</script>',
    );
  });

  it("スロットの内容が保留中なら、<slot> を囲む境界の差し替えとして、内容の全体を送る", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const Container = defineElement(
      "x-container",
      () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
      { props: { children: "slot" } },
    );
    const Child = defineElement(
      "x-child",
      () => {
        const value = memo(() => promise);
        return jsx("i", { children: () => value() });
      },
      { props: {} },
    );
    const reading = read(renderToStream(jsx(Container, { children: jsx(Child, {}) })));
    await tick();
    resolve("v");
    const html = (await reading).join("");
    expect(html).toContain(
      '<x-container data-oh="h1" data-om="@b"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template><template data-ob="p4"></template><!--/ob:p4--></x-container>',
    );
    expect(html).toContain(
      '<template data-os="b2"><slot></slot></template><template data-op="p4"><x-child data-oh="h3"><template shadowrootmode="open"><i>v</i></template></x-child></template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[["p4",[]]]})</script><script>$rinka.d("h1",{"@b":1})</script>',
    );
  });
});

describe("スロットの内容の保留中のタグ", () => {
  it("属性が保留中のタグは、タグの全体を <slot> を囲む境界の差し替えにする", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const Container = defineElement(
      "x-wrap",
      () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
      { props: { children: "slot" } },
    );
    const value = createRoot(() => memo(() => promise));
    const reading = read(
      renderToStream(
        jsx(Container, { children: jsx("b", { title: () => value(), children: "t" }) }),
      ),
    );
    await tick();
    resolve("v");
    const html = (await reading).join("");
    expect(html).toContain(
      '<x-wrap data-oh="h1" data-om="@b"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template><template data-ob="p3"></template><!--/ob:p3--></x-wrap>',
    );
    expect(html).toContain('<template data-op="p3"><b title="v">t</b></template>');
  });
});

/** フォールバックの描画に失敗するコンポーネントである。 */
const BrokenFallback = () => {
  throw new Error("fallback");
};

/** 外から失敗させられる async のコンポーネントを作成する。 */
function failing(error: unknown = new Error("e")) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const Fail = async () => {
    await promise;
    throw error;
  };
  return { Fail, reject: resolve };
}

describe("境界を待つホスト", () => {
  it("保留中でない境界は、ホストに待たせない", async () => {
    const Now = defineElement("x-now", () => jsx(Loading, { fallback: "f", children: "now" }), {
      props: {},
    });
    const html = (await read(renderToStream(jsx(Now, {})))).join("");
    expect(html).toContain(
      '<x-now data-oh="h1"><template shadowrootmode="open">now</template></x-now>',
    );
  });

  it("値が解決してから現れた境界も、ホストに待たせる", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const slow = deferred("in");
    const Later = defineElement(
      "x-later",
      () => {
        const value = memo(() => promise);
        return () => value() && jsx(Loading, { fallback: "f", children: jsx(slow.Slow, {}) });
      },
      { props: {} },
    );
    const reading = read(renderToStream(jsx(Later, {})));
    await tick();
    resolve("v");
    await tick();
    slow.resolve();
    const html = (await reading).join("");
    expect(html).toContain('<x-later data-oh="h1" data-om="@b">');
  });

  it("フォールバックの中の境界はホストに待たせず、使わないフォールバックは描画しない", async () => {
    let rendered = 0;
    const Unused = defineElement(
      "x-unused",
      () =>
        jsx(Loading, {
          fallback: () => {
            rendered++;
            return jsx(Loading, { fallback: "ff", children: "x" });
          },
          children: "now",
        }),
      { props: {} },
    );
    const html = (await read(renderToStream(jsx(Unused, {})))).join("");
    expect(html).toContain('<x-unused data-oh="h1"><template shadowrootmode="open">now</template>');
    expect(rendered).toBe(0);
  });

  it("開始タグを出力した後に現れた入れ子の境界も、送り終えてからホストに @b を送る", async () => {
    const inner = deferred("in");
    const outer = deferred(jsx(Loading, { fallback: "i", children: jsx(inner.Slow, {}) }));
    const Nested = defineElement(
      "x-nested",
      () => jsx(Loading, { fallback: "o", children: jsx(outer.Slow, {}) }),
      { props: {} },
    );
    const reading = read(renderToStream(jsx(Nested, {})));
    await tick();
    outer.resolve();
    await tick();
    inner.resolve();
    const html = (await reading).join("");
    expect(html).toContain('<x-nested data-oh="h1" data-om="@b">');
    const outerAt = html.indexOf('$rinka.r({"b":"b2","bp":["h1"],"p":[]})');
    const innerAt = html.indexOf('$rinka.r({"b":"b3","bp":["h1"],"p":[]})');
    expect(outerAt).toBeGreaterThan(0);
    expect(innerAt).toBeGreaterThan(outerAt);
    expect(html.split('$rinka.d("h1",{"@b":1})')).toHaveLength(2);
    expect(html.indexOf('$rinka.d("h1",{"@b":1})')).toBeGreaterThan(innerAt);
  });

  it("失敗して送らない境界も、送り終えた境界として数え、ホストに @b を送る", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const Broken = defineElement(
      "x-broken",
      () => jsx(Loading, { fallback: "f", children: jsx(Fail, {}) }),
      { props: {} },
    );
    const reading = read(renderToStream(jsx(Broken, {})));
    await tick();
    reject();
    const html = (await reading).join("");
    expect(html).not.toContain('<template data-os="b2"');
    expect(html).toContain('<script>$rinka.d("h1",{"@b":1})</script>');
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("境界の失敗と順序", () => {
  it("埋め込んだ境界の中の境界は、外側の境界が失敗すると送らない", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const inner = deferred("inner-done");
    const reading = read(
      renderToStream(
        jsx(Loading, {
          fallback: "o",
          children: [
            jsx(Fail, {}),
            jsx(Loading, {
              fallback: "m",
              children: jsx(Loading, { fallback: "i", children: jsx(inner.Slow, {}) }),
            }),
          ],
        }),
      ),
    );
    await tick();
    inner.resolve();
    await tick();
    reject();
    const html = (await reading).join("");
    expect(html).not.toContain("inner-done");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("目印を囲む Errored がフォールバックに切り替わった境界は、中身を送らない", async () => {
    const { Fail, reject } = failing();
    const slow = deferred("slow-done");
    const reading = read(
      renderToStream(
        jsx(Loading, {
          fallback: "o",
          children: jsx(Errored, {
            fallback: "EB",
            children: [
              jsx(Fail, {}),
              jsx(Loading, { fallback: "i", children: jsx(slow.Slow, {}) }),
            ],
          }),
        }),
      ),
    );
    await tick();
    reject();
    await tick();
    slow.resolve();
    const html = (await reading).join("");
    expect(html).toContain('<template data-os="b1">EB</template>');
    expect(html).not.toContain("slow-done");
  });

  it("Loading を外側から囲む Errored は、シェルを送った後の中身の失敗を受け止め、領域の全体をフォールバックに差し替える", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const slow = deferred("slow-done");
    const reading = read(
      renderToStream(
        jsx("main", {
          children: jsx(Errored, {
            fallback: (cause: unknown) => jsx("p", { children: String(cause) }),
            children: [
              "before",
              jsx(Loading, { fallback: "f", children: jsx(Fail, {}) }),
              jsx(Loading, { fallback: "s", children: jsx(slow.Slow, {}) }),
            ],
          }),
        }),
      ),
    );
    await tick();
    reject();
    await tick();
    slow.resolve();
    const chunks = await reading;
    const html = chunks.join("");
    expect(chunks[0]).toContain(
      '<main><template data-ob="e1"></template>before<template data-ob="b1"></template>f<!--/ob:b1--><template data-ob="b2"></template>s<!--/ob:b2--><!--/ob:e1--></main>',
    );
    expect(html).toContain(
      '<template data-os="e1"><p>Error: e</p></template><script>$rinka.r({"b":"e1","bp":[],"p":[]})</script>',
    );
    expect(html).not.toContain("slow-done");
    expect(error).not.toHaveBeenCalled();
  });

  it("内側の Errored のフォールバックの中の Loading が失敗すると、目印を出力した外側の Errored の領域を差し替える", async () => {
    const first = failing();
    const second = failing();
    const reading = read(
      renderToStream(
        jsx("main", {
          children: jsx(Errored, {
            fallback: "OUTER",
            children: jsx(Errored, {
              fallback: () => jsx(Loading, { fallback: "x", children: jsx(second.Fail, {}) }),
              children: jsx(Loading, { fallback: "f", children: jsx(first.Fail, {}) }),
            }),
          }),
        }),
      ),
    );
    await tick();
    first.reject();
    await tick();
    second.reject();
    const html = (await reading).join("");
    expect(html).toMatch(
      /<template data-os="(e\d+)">OUTER<\/template><script>\$rinka\.r\(\{"b":"\1"/,
    );
  });

  it("スロットの内容の差し替えの中の境界の失敗も、データの解決の順序に関わらず、Loading を外側から囲む Errored が受け止める", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const slow = deferred("slow");
    const Frame = defineElement(
      "x-errored-frame",
      () => jsx(Loading, { fallback: "wait", children: [jsx(slow.Slow, {}), jsx("slot", {})] }),
      { props: { children: "slot" } },
    );
    const late = Promise.withResolvers<void>();
    const Wrapper = async () => {
      await late.promise;
      return jsx(Loading, { fallback: "inner", children: jsx(Fail, {}) });
    };
    const reading = read(
      renderToStream(
        jsx("main", {
          children: jsx(Errored, {
            fallback: "FB",
            children: jsx(Frame, { children: jsx(Wrapper, {}) }),
          }),
        }),
      ),
    );
    await tick();
    late.resolve();
    await tick();
    slow.resolve();
    await tick();
    reject();
    const html = (await reading).join("");
    expect(html).toContain('<template data-os="e1">FB</template>');
    expect(error).not.toHaveBeenCalled();
  });

  it("Errored のフォールバックの描画が失敗しても、同じ領域の境界を送り、元のエラーを記録する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const slow = deferred("OK");
    const reading = read(
      renderToStream(
        jsx("main", {
          children: jsx(Errored, {
            fallback: () => jsx(BrokenFallback, {}),
            children: [
              jsx(Loading, { fallback: "f", children: jsx(Fail, {}) }),
              jsx(Loading, { fallback: "s", children: jsx(slow.Slow, {}) }),
            ],
          }),
        }),
      ),
    );
    await tick();
    reject();
    await tick();
    slow.resolve();
    const html = (await reading).join("");
    expect(html).toContain(">OK</template>");
    expect(error.mock.calls.flat()).toContainEqual(new Error("e"));
  });

  it("シェルを送った後に描画する Errored のフォールバックの <title> は、<head> に移動せずにその場に出力する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const reading = read(
      renderToStream(
        jsx(Errored, {
          fallback: [jsx("title", { children: "失敗" }), "FB"],
          children: jsx(Loading, { fallback: "f", children: jsx(Fail, {}) }),
        }),
      ),
    );
    await tick();
    reject();
    const html = (await reading).join("");
    expect(html).toContain('<template data-os="e1"><title>失敗</title>FB</template>');
  });

  it("<title> と <textarea> の中の Errored は、目印を出力しない", async () => {
    const html = (
      await read(
        renderToStream(
          jsx("main", {
            children: [
              jsx("title", { children: jsx(Errored, { fallback: "App", children: "Page" }) }),
              jsx("textarea", { children: jsx(Errored, { fallback: "", children: "text" }) }),
            ],
          }),
        ),
      )
    ).join("");
    expect(html).toContain("<title>Page</title>");
    expect(html).toContain("<textarea>text</textarea>");
  });

  it("シェルを送った後に notFound() を受け止めた、Loading の外側の Errored は、noindex を出力する", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const Missing = async () => {
      await promise;
      throw notFound();
    };
    const reading = read(
      renderToStream(
        jsx(Errored, {
          fallback: "gone",
          children: jsx(Loading, { fallback: "f", children: jsx(Missing, {}) }),
        }),
      ),
    );
    await tick();
    resolve();
    const html = (await reading).join("");
    expect(html).toContain(
      '<meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script><template data-os="e1">gone</template>',
    );
  });

  it.each([
    ["redirect()", () => redirect("/next")],
    ["3xx の Response", () => new Response(null, { status: 302, headers: { location: "/next" } })],
  ])(
    "シェルを送った後に、Errored のフォールバックが投げた %s は、Errored が 1 段でも、外側に Errored があっても、エラーを記録せずにページを移動させる",
    async (_name, moved) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const outer of [false, true]) {
        const { Fail, reject } = failing();
        const inner = jsx(Errored, {
          fallback: () => {
            // oxlint-disable-next-line typescript/only-throw-error
            throw moved();
          },
          children: jsx(Loading, { fallback: "f", children: jsx(Fail, {}) }),
        });
        const reading = read(
          renderToStream(outer ? jsx(Errored, { fallback: "outer", children: inner }) : inner),
        );
        // oxlint-disable-next-line no-await-in-loop
        await tick();
        reject();
        // oxlint-disable-next-line no-await-in-loop
        const html = (await reading).join("");
        expect(html).toContain('<script>location.replace("/next")</script>');
        expect(html).not.toContain("<template data-os");
      }
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("保留中でない境界の中にある保留中の境界も、送り終えてからストリームを閉じる", async () => {
    const inner = deferred("in");
    const reading = read(
      renderToStream(
        jsx(Loading, {
          fallback: "o",
          children: jsx(Loading, { fallback: "i", children: jsx(inner.Slow, {}) }),
        }),
      ),
    );
    await tick();
    inner.resolve();
    const html = (await reading).join("");
    expect(html).toContain('<template data-os="b2">in</template>');
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("スロットの内容の中の Errored は、差し替えの中で失敗を受け止める", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const Container = defineElement(
      "x-catch",
      () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
      { props: { children: "slot" } },
    );
    const reading = read(
      renderToStream(
        jsx(Container, { children: jsx(Errored, { fallback: "caught", children: jsx(Fail, {}) }) }),
      ),
    );
    await tick();
    reject();
    const html = (await reading).join("");
    expect(html).toContain('<template data-op="p3">caught</template>');
    expect(error).not.toHaveBeenCalled();
  });

  it("内側の要素の Light DOM に渡した <slot> も、外側の要素の境界に登録する", async () => {
    const slow = deferred("late");
    const Inner = defineElement("x-inner", () => jsx("slot", {}), { props: { children: "slot" } });
    const Outer = defineElement(
      "x-outer",
      () => jsx(Loading, { fallback: "wait", children: jsx(Inner, { children: jsx("slot", {}) }) }),
      { props: { children: "slot" } },
    );
    const stream = renderToStream(jsx(Outer, { children: jsx(slow.Slow, {}) }));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await Promise.race([
      reader.read().then(({ value }) => decoder.decode(value)),
      tick().then(() => "シェルが送られない"),
    ]);
    expect(first).toContain('<template data-ob="p4"></template><!--/ob:p4-->');
    reader.releaseLock();
    slow.resolve();
    const rest: string[] = [];
    for await (const chunk of stream) rest.push(decoder.decode(chunk));
    checkOrder([first, ...rest]);
    expect(rest.join("")).toContain('<template data-op="p4">late</template>');
  });
});

describe("blocking と起動スクリプト", () => {
  it("blocking でも、要素があれば起動スクリプトを出力する", async () => {
    const Plain = defineElement("x-plain", () => "p", { props: {} });
    const html = (await read(renderToStream(jsx(Plain, {}), { blocking: true }))).join("");
    expect(html).toContain("window.$rinka");
  });
});

describe("Response", () => {
  it("renderToResponse は、シェルが揃った時点で HTML の Response を返す", async () => {
    const response = await renderToResponse(jsx("p", { children: "hi" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await readText(response)).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><p>hi</p></body></html>',
    );
  });
});

describe("isBot", () => {
  it("検索エンジンのクローラーとリンクのプレビューのサービスを bot と判定する", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(
      true,
    );
    expect(isBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(isBot("Twitterbot/1.0")).toBe(true);
    expect(
      isBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isBot(undefined)).toBe(false);
  });
});

describe("出力の順序", () => {
  it("シェルの中の Errored が、要素の中の後送りの境界が解決した後で受け止めても、文書の先頭から出力する", async () => {
    const slow = deferred("s");
    const { Fail, reject } = failing();
    const Card = defineElement(
      "x-caught",
      () => jsx(Loading, { fallback: "f", children: jsx(slow.Slow, {}) }),
      { props: {} },
    );
    const reading = read(
      renderToStream(
        jsx("main", {
          children: jsx(Errored, {
            fallback: () => "caught",
            children: [jsx(Card, {}), jsx(Fail, {})],
          }),
        }),
      ),
    );
    await tick();
    slow.resolve();
    await tick();
    reject();
    const chunks = await reading;
    expect(chunks[0]).toMatch(/^<!doctype html>/);
    expect(chunks.join("")).toContain("<main>caught</main>");
  });
});

describe("スロットの内容の中の境界", () => {
  it("<slot> を囲む境界が失敗しても、シェルに出力したスロットの内容の中の境界は送る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { Fail, reject } = failing();
    const slow = deferred("in");
    const Frame = defineElement(
      "x-frame",
      () => jsx(Loading, { fallback: "f", children: [jsx(Fail, {}), jsx("slot", {})] }),
      { props: { children: "slot" } },
    );
    const reading = read(
      renderToStream(
        jsx(Frame, { children: jsx(Loading, { fallback: "w", children: jsx(slow.Slow, {}) }) }),
      ),
    );
    await tick();
    reject();
    await tick();
    slow.resolve();
    const html = (await reading).join("");
    expect(html).toMatch(/<template data-os="b\d+">in<\/template>/);
  });
});
