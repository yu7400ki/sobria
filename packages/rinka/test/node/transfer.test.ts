import { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getContext, runInRequest } from "../../src/server/context.ts";
import { Errored, Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { registerServerFn } from "../../src/server/internal.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream, renderToString } from "../../src/server/response.ts";
import { defineServerFn } from "../../src/server/server-fn.ts";
import { siteMemo as memo } from "../../src/shared/signals.ts";
import { read } from "./stream-order.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 値が無いことを表す、`$rinka.n` の代わりのオブジェクト。 */
const missing = { missing: true };

/**
 * `node` を文書として描画し、HTML と、出力したスクリプトが `$rinka.d` に渡した値を返す。
 * `$rinka.s` で作成したストリームは、`{ stream: 最初の値 }` にする。
 */
async function render(node: unknown, options: { blocking?: boolean } = {}) {
  const html = (await read(renderToStream(node, options))).join("");
  const sent: [string, Record<string, unknown>][] = [];
  const rinka = {
    n: missing,
    d: (id: string, values: Record<string, unknown>) => sent.push([id, values]),
    s: (value: unknown) => ({ stream: value }),
    f: (id: string, method: string) => ({ serverFn: [id, method] }),
    r: () => {},
  };
  for (const [, script] of html.matchAll(/<script>(.*?)<\/script>/gs)) {
    if (script === undefined || script.startsWith("(R=>")) continue;
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function("$rinka", script)(rinka);
  }
  return { html, sent };
}

/** 呼び出し箇所 `site` の非同期の memo の値を表示する要素を登録する。 */
function defineAsync(tag: string, site: string, compute: () => Promise<unknown>) {
  return defineElement(
    tag,
    () => {
      const value = memo(compute, { site });
      return jsx("p", { children: () => String(value()) });
    },
    { props: {} },
  );
}

/** 明示的なキー `keys` の非同期の memo を作成する要素を登録する。 */
const defineKeyed = (tag: string, keys: string[]) =>
  defineElement(
    tag,
    () => {
      for (const key of keys) memo(() => Promise.resolve(1), { key });
      return null;
    },
    { props: {} },
  );
describe("memo の値", () => {
  it("キーのある非同期の memo の値を、data-om に列挙して $rinka.d で送る", async () => {
    const Card = defineAsync("x-tr1", "c.tsx:1:1", () => Promise.resolve(new Date(0)));
    const { html, sent } = await render(jsx(Card, {}));
    expect(html).toContain('<x-tr1 data-oh="h1" data-om="c.tsx:1:1#0">');
    expect(sent).toEqual([["h1", { "c.tsx:1:1#0": new Date(0) }]]);
  });

  it("同期の memo と、キーの無い memo の値は送らない", async () => {
    const Card = defineElement(
      "x-tr2",
      () => {
        const sync = memo(() => 1, { site: "c.tsx:2:1" });
        const unkeyed = memo(() => Promise.resolve(2));
        return jsx("p", { children: () => sync() + unkeyed() });
      },
      { props: {} },
    );
    const { html, sent } = await render(jsx(Card, {}));
    expect(html).toContain(
      '<x-tr2 data-oh="h1"><template shadowrootmode="open"><!--[--><p><!--[-->3<!--]--></p>',
    );
    expect(sent).toEqual([]);
  });

  it("失敗した memo のキーには、値が無いことを送る", async () => {
    const Card = defineElement(
      "x-tr3",
      () => {
        const value = memo(() => Promise.reject(new Error("e")), { site: "c.tsx:3:1" });
        return jsx(Loading, { fallback: "f", children: jsx("p", { children: () => value() }) });
      },
      { props: {} },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sent } = await render(jsx(Card, {}));
    expect(sent).toContainEqual(["h1", { "c.tsx:3:1#0": missing }]);
  });

  it("シリアライズできない値は、値が無いことを送って記録する", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class User {
      readonly name = "u";
    }
    const Card = defineAsync("x-tr4", "c.tsx:4:1", () => Promise.resolve(new User()));
    const { sent } = await render(jsx(Card, {}));
    expect(sent).toEqual([["h1", { "c.tsx:4:1#0": missing }]]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("明示的なキーに使用できない値を指定すると、エラーにする", async () => {
    await expect(renderToString(jsx(defineKeyed("x-tr5", ["a b"]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr6", ["@x"]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr7", [""]), {}))).rejects.toThrow("キー");
    await expect(renderToString(jsx(defineKeyed("x-tr8", ["k", "k"]), {}))).rejects.toThrow("キー");
  });
});

describe("props の値", () => {
  const Card = defineElement(
    "x-tr-card",
    (props: { data?: object; onPick?: () => void }) =>
      jsx("p", { children: () => typeof props.data }),
    { props: { data: "unknown", onPick: "function" } },
  );

  it("属性にできない props を、@p として $rinka.d で送る", async () => {
    const { html, sent } = await render(jsx(Card, { data: { a: [1] } }));
    expect(html).toContain('<x-tr-card data-oh="h1" data-om="@p">');
    expect(sent).toEqual([["h1", { "@p": { data: { a: [1] } } }]]);
  });

  it("BigInt の props は、属性にせずに @p として送る", async () => {
    const { html, sent } = await render(jsx(Card, { data: 10n }));
    expect(html).toContain('<x-tr-card data-oh="h1" data-om="@p">');
    expect(sent).toEqual([["h1", { "@p": { data: 10n } }]]);
  });

  it("サーバー関数の props は、オブジェクトの中にあっても、$rinka.f の呼び出しにして送る", async () => {
    const like = registerServerFn(
      "src/fns.ts#like",
      defineServerFn(() => null),
    );
    const { sent } = await render(jsx(Card, { onPick: like, data: { like } }));
    const reference = { serverFn: ["src/fns.ts#like", "POST"] };
    expect(sent).toEqual([["h1", { "@p": { onPick: reference, data: { like: reference } } }]]);
  });

  it("要素の Shadow DOM の中の子要素には、属性にできない props を送らない", async () => {
    const Outer = defineElement(
      "x-tr-outer",
      () => jsx(Card, { data: { a: 1 }, onPick: () => {} }),
      { props: {} },
    );
    const { html, sent } = await render(jsx(Outer, {}));
    expect(html).toContain(
      '<x-tr-card data-oh="h2"><template shadowrootmode="open"><!--[--><p><!--[-->object<!--]--></p>',
    );
    expect(sent).toEqual([]);
  });
});

describe("入れ子の子要素", () => {
  it("前の描画で作成した子要素のノードを再利用しても、前の描画のホストに値を送らない", async () => {
    const Leaf = defineElement("x-tr-leaf", () => null, { props: {} });
    let cached: unknown;
    const Outer = defineElement(
      "x-tr-outer",
      () => (cached ??= jsx(Leaf, {}, undefined, "o.tsx:1:1")),
      { props: {} },
    );
    await render(jsx(Outer, {}));
    const second = await render(jsx(Outer, {}));
    expect(second.html.startsWith("<!doctype html>")).toBe(true);
    expect(second.sent).toEqual([]);
  });
  it("親の描画で作成した子要素のホストの ID を、呼び出し箇所と回数のキーで親に送る", async () => {
    const Child = defineAsync("x-tr-child", "c.tsx:9:1", () => Promise.resolve("v"));
    const Parent = defineElement(
      "x-tr-parent",
      () => [jsx(Child, {}, undefined, "p.tsx:1:1"), jsx(Child, {}, undefined, "p.tsx:1:1")],
      { props: {} },
    );
    const { html, sent } = await render(jsx(Parent, {}));
    expect(html).toContain('<x-tr-parent data-oh="h1" data-om="@c:p.tsx:1:1#0 @c:p.tsx:1:1#1">');
    expect(sent).toContainEqual(["h1", { "@c:p.tsx:1:1#0": "h2" }]);
    expect(sent).toContainEqual(["h1", { "@c:p.tsx:1:1#1": "h3" }]);
  });
});

/** 同期的にエラーを投げるコンポーネントである。 */
const Sync = () => {
  throw new Error("sync");
};
/** 5ms 後に失敗する async のコンポーネントである。 */
const late = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw new Error("late");
};
/** `x-tr-shown` のホスト `host` に送る値の列を返す。 */
const shownValues = (host: string) => [
  [host, { "s.tsx:1:1#0": "v" }],
  [host, { "@p": { data: { a: 1 } } }],
];

/** `ms` ミリ秒後に解決する Promise を返す。 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `ms` ミリ秒待ってから `content` を返す、async のコンポーネントを作成する。 */
const after = (ms: number, content: unknown) => async () => {
  await wait(ms);
  return content;
};

/** 中身を 100 ミリ秒後に出力する `<Loading>` を作成する。ストリームは、それまで閉じない。 */
const holding = () => jsx(Loading, { fallback: "w", children: jsx(after(100, "done"), {}) });

describe("開始タグの後に加わったキー", () => {
  it("Errored が捨てた領域の中で後から後送りにした境界は、外側のホストに @b を送らない", async () => {
    const Host = defineElement(
      "x-tr-sealed-b",
      () =>
        jsx(Errored, {
          fallback: "fb",
          children: [
            jsx(late, {}),
            jsx(after(10, jsx(Loading, { fallback: "f", children: jsx(after(20, "x"), {}) })), {}),
          ],
        }),
      { props: {} },
    );
    const { sent } = await render([jsx(Host, {}), holding()]);
    expect(sent).toEqual([]);
  });

  it("Errored が捨てた領域の中で後から描画した子要素は、外側のホストに @c:キーを送らない", async () => {
    const Leaf = defineElement("x-tr-sealed-leaf", () => null, { props: {} });
    const Host = defineElement(
      "x-tr-sealed-c",
      () => {
        const leaf = jsx(Leaf, {}, undefined, "s.tsx:9:1");
        return jsx(Errored, {
          fallback: "fb",
          children: [jsx(late, {}), jsx(after(10, leaf), {})],
        });
      },
      { props: {} },
    );
    const { sent } = await render([jsx(Host, {}), holding()]);
    expect(sent).toEqual([]);
  });

  it("後送りにした中身の中で作成した子要素は、外側のホストの @b より前に @c:キーを送る", async () => {
    const Leaf = defineElement("x-tr-late-leaf", () => null, { props: {} });
    const Host = defineElement(
      "x-tr-late-c",
      () => {
        const leaf = jsx(Leaf, {}, undefined, "s.tsx:1:1");
        return jsx(Loading, { fallback: "f", children: jsx(after(10, leaf), {}) });
      },
      { props: {} },
    );
    const { html, sent } = await render(jsx(Host, {}));
    expect(html).toContain('<template data-os="b2"><x-tr-late-leaf data-oh="h3">');
    expect(sent).toEqual([
      ["h1", { "@c:s.tsx:1:1#0": "h3" }],
      ["h1", { "@b": 1 }],
    ]);
  });

  it("後送りにした <Loading> の中で、中身を出力した <Errored> の中に作成した子要素も、@b より前に @c:キーを送る", async () => {
    const Leaf = defineElement("x-tr-late-errored-leaf", () => null, { props: {} });
    const Host = defineElement(
      "x-tr-late-errored",
      () => {
        const leaf = jsx(Leaf, {}, undefined, "s.tsx:1:1");
        return jsx(Loading, {
          fallback: "f",
          children: jsx(Errored, { fallback: "fb", children: jsx(after(10, leaf), {}) }),
        });
      },
      { props: {} },
    );
    const { sent } = await render(jsx(Host, {}));
    expect(sent).toEqual([
      ["h1", { "@c:s.tsx:1:1#0": "h3" }],
      ["h1", { "@b": 1 }],
    ]);
  });

  it("後送りにした差し替えの中で作成した子要素も、@b より前に @c:キーを送る", async () => {
    const Leaf = defineElement("x-tr-late-slot-leaf", () => null, { props: {} });
    const Inner = defineElement(
      "x-tr-late-slot-inner",
      () => jsx(Loading, { fallback: "f", children: jsx("slot", {}) }),
      { props: {} },
    );
    const Host = defineElement(
      "x-tr-late-slot",
      () => {
        const leaf = jsx(Leaf, {}, undefined, "s.tsx:1:1");
        return jsx(Inner, { children: jsx(after(10, leaf), {}) });
      },
      { props: {} },
    );
    const { html, sent } = await render(jsx(Host, {}));
    expect(html).toContain('<template data-op="p4"><x-tr-late-slot-leaf data-oh="h5">');
    expect(sent).toEqual([
      ["h1", { "@c:s.tsx:1:1#0": "h5" }],
      ["h1", { "@b": 1 }],
      ["h2", { "@b": 1 }],
    ]);
  });

  it("後送りにした中身の中のホストに値を送り、外側のホストに @b を送る", async () => {
    const Inner = defineAsync("x-tr-late-inner", "i.tsx:1:1", async () => 7);
    const Host = defineElement(
      "x-tr-late-outer",
      () => jsx(Loading, { fallback: "f", children: jsx(after(10, jsx(Inner, {})), {}) }),
      { props: {} },
    );
    const { html, sent } = await render(jsx(Host, {}));
    expect(html).toContain('<x-tr-late-inner data-oh="h3" data-om="i.tsx:1:1#0">');
    expect(sent.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ["h1", { "@b": 1 }],
      ["h3", { "i.tsx:1:1#0": 7 }],
    ]);
  });

  it("開始タグの後に初めて非同期になった memo の値は送らない", async () => {
    const Host = defineElement(
      "x-tr-sealed-memo",
      () => {
        const source = memo(() => wait(5).then(() => "v"));
        memo(() => Promise.resolve(source()), { key: "b" });
        return "x";
      },
      { props: {} },
    );
    const { sent } = await render([jsx(Host, {}), holding()]);
    expect(sent).toEqual([]);
  });

  it(
    "開始タグの後に初めて非同期になった memo が解決しなくても、ストリームを閉じる",
    { timeout: 1000 },
    async () => {
      const Host = defineElement(
        "x-tr-sealed-never",
        () => {
          const source = memo(() => wait(5).then(() => "v"));
          memo(
            () => {
              source();
              return new Promise<never>(() => {});
            },
            { key: "b" },
          );
          return "x";
        },
        { props: {} },
      );
      const { sent } = await render([jsx(Host, {}), holding()]);
      expect(sent).toEqual([]);
    },
  );

  it("ほかに後送りの境界が無くても、ストリームを閉じた後に書き込まない", async () => {
    const Host = defineElement(
      "x-tr-sealed-closed",
      () =>
        jsx(Errored, {
          fallback: "fb",
          children: [
            jsx(late, {}),
            jsx(after(10, jsx(Loading, { fallback: "f", children: jsx(after(20, "x"), {}) })), {}),
          ],
        }),
      { props: {} },
    );
    const rejected: unknown[] = [];
    const listener = (reason: unknown) => rejected.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await render(jsx(Host, {}));
      await wait(60);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(rejected).toEqual([]);
  });
});

describe("値を送る範囲", () => {
  const Card = defineElement(
    "x-tr-shown",
    (props: { data?: object }) => {
      const value = memo(() => Promise.resolve("v"), { site: "s.tsx:1:1" });
      return jsx("p", { children: () => `${value()} ${typeof props.data}` });
    },
    { props: { data: "unknown" } },
  );

  it("Errored がフォールバックに切り替えた領域の中のホストには、値を送らない", async () => {
    const sync = await render(
      jsx(Errored, { fallback: "fb", children: [jsx(Card, { data: { a: 1 } }), jsx(Sync, {})] }),
    );
    expect(sync.sent).toEqual([]);
    const async = await render(
      jsx(Errored, { fallback: "fb", children: [jsx(Card, { data: { a: 1 } }), jsx(late, {})] }),
    );
    expect(async.html).toContain("<body>fb");
    expect(async.sent).toEqual([]);
  });

  it.each([1, 3, 6])(
    "%i 段の Errored が受け止めなかった領域の中のホストには、値を送る",
    async (depth) => {
      const wrap = (rest: number, child: unknown): unknown =>
        rest === 0 ? child : jsx(Errored, { fallback: "fb", children: wrap(rest - 1, child) });
      const shell = await render(wrap(depth, jsx(Card, { data: { a: 1 } })));
      expect(shell.sent).toEqual(shownValues("h1"));
      const deferred = await render(
        jsx(Loading, { fallback: "f", children: wrap(depth, jsx(Card, { data: { a: 1 } })) }),
      );
      expect(deferred.sent).toEqual(shownValues("h2"));
    },
  );

  it("Errored がフォールバックに切り替えた領域の中のホストには、@b を送らない", async () => {
    const Waiting = defineElement(
      "x-tr-waiting",
      () =>
        jsx(Loading, {
          fallback: "f",
          children: jsx(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return "in";
          }, {}),
        }),
      { props: {} },
    );
    const { html, sent } = await render(
      jsx(Errored, { fallback: "fb", children: [jsx(Waiting, {}), jsx(late, {})] }),
    );
    expect(html).toContain("<body>fb");
    expect(sent).toEqual([]);
  });

  it("出力しないホストの memo が、境界をすべて出力した後で解決しても、ストリームを閉じる", async () => {
    const Slow = defineAsync(
      "x-tr-slow",
      "s.tsx:3:1",
      () => new Promise((resolve) => setTimeout(() => resolve("v"), 30)),
    );
    const { html, sent } = await render(
      jsx(Errored, { fallback: "fb", children: [jsx(Slow, {}), jsx(Sync, {})] }),
    );
    expect(html.endsWith("</body></html>")).toBe(true);
    expect(sent).toEqual([]);
  });

  it("値とキーに含まれる </script> は、スクリプトを閉じない", async () => {
    const Card2 = defineAsync("x-tr-escape", "e.tsx:</script>", () =>
      Promise.resolve("</script><b>"),
    );
    const { html, sent } = await render(jsx(Card2, {}));
    expect(html).not.toContain("</script><b>");
    expect(sent).toEqual([["h1", { "e.tsx:</script>#0": "</script><b>" }]]);
  });

  it("入れ子の要素の memo のキーは、要素ごとに数える", async () => {
    const Inner = defineAsync("x-tr-inner", "s.tsx:2:1", () => Promise.resolve(1));
    const Outer = defineElement(
      "x-tr-nest",
      () => {
        const a = memo(() => Promise.resolve(1), { site: "s.tsx:2:1" });
        const b = memo(() => Promise.resolve(2), { site: "s.tsx:2:1" });
        return [jsx("i", { children: () => a() + b() }), jsx(Inner, {})];
      },
      { props: {} },
    );
    const { html } = await render(jsx(Outer, {}));
    expect(html).toContain('<x-tr-nest data-oh="h1" data-om="s.tsx:2:1#0 s.tsx:2:1#1">');
    expect(html).toContain('<x-tr-inner data-oh="h2" data-om="s.tsx:2:1#0">');
  });
});

/** "a" を yield し、続けて "b" と "c" を yield する。反復を終えたら `closed` を真にする。 */
function lettersOf() {
  const state = { closed: false };
  async function* letters() {
    try {
      yield "a";
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield "b";
      yield "c";
    } finally {
      state.closed = true;
    }
  }
  return { letters, state };
}

/** 呼び出し箇所 `site` の memo の値を表示する要素を登録する。memo の関数は `compute` である。 */
const defineStreamed = (tag: string, site: string, compute: () => unknown) =>
  defineElement(
    tag,
    () => {
      const value = memo(compute as () => AsyncIterable<string>, { site });
      return jsx(Errored, {
        fallback: "failed",
        children: jsx("p", { children: () => value() }),
      });
    },
    { props: {} },
  );

/** 値を yield する前に失敗する。 */
// oxlint-disable-next-line require-yield
async function* failsFirst() {
  throw new Error("e");
}

/**
 * `values` を順に返して終わり、`next` と `return` の呼び出しを `calls` に記録する async iterable を返す。
 * 0 から数えて `hold` 回目の `next` は解決しない。
 */
function recorded(values: readonly string[], hold?: number) {
  const calls: string[] = [];
  let index = 0;
  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        calls.push("next");
        const at = index++;
        if (at === hold) return new Promise(() => {});
        const value = values[at];
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
      return: async () => {
        calls.push("return");
        return { done: true, value: undefined };
      },
    }),
  };
  return { iterable, calls };
}

/** シェルの描画で投げるコンポーネントである。 */
const Thrower = () => {
  throw new Error("shell");
};

describe("ストリームの memo", () => {
  it("最初の値で描画して $rinka.s で送り、iterable を閉じる。async iterable に解決する Promise も同じである", async () => {
    const direct = recorded(["a", "b"], 1);
    const wrapped = recorded(["a", "b"], 1);
    const ended = recorded([]);
    const Direct = defineStreamed("x-st1", "s.tsx:1:1", () => direct.iterable);
    const Wrapped = defineStreamed("x-st2", "s.tsx:2:1", () => Promise.resolve(wrapped.iterable));
    const Ended = defineStreamed("x-st3", "s.tsx:3:1", () => ended.iterable);
    const { html, sent } = await render([jsx(Direct, {}), jsx(Wrapped, {}), jsx(Ended, {})]);
    expect(html.split("<p><!--[-->a<!--]--></p>")).toHaveLength(3);
    expect(sent).toContainEqual(["h1", { "s.tsx:1:1#0": { stream: "a" } }]);
    expect(sent).toContainEqual(["h2", { "s.tsx:2:1#0": { stream: "a" } }]);
    expect(sent).toContainEqual(["h3", { "s.tsx:3:1#0": missing }]);
    expect(html).not.toContain("$rinka.p(");
    expect([direct.calls, wrapped.calls, ended.calls]).toEqual([
      ["next", "return"],
      ["next", "return"],
      ["next"],
    ]);
  });

  it("最初の値の前に失敗したら、<Errored> のフォールバックを描画し、値が無いことを送る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Card = defineStreamed("x-st4", "s.tsx:4:1", () => failsFirst());
    const { html, sent } = await render(jsx(Card, {}));
    expect(html).toContain("<!--!-->failed<!--]-->");
    expect(sent).toContainEqual(["h1", { "s.tsx:4:1#0": missing }]);
  });

  it("すべての <Loading> を待つ描画でも、最初の値を $rinka.s で送り、iterable を閉じる", async () => {
    const { letters, state } = lettersOf();
    const Card = defineStreamed("x-st5", "s.tsx:5:1", () => letters());
    const { html, sent } = await render(jsx(Card, {}), { blocking: true });
    expect(sent).toContainEqual(["h1", { "s.tsx:5:1#0": { stream: "a" } }]);
    expect(html).not.toContain("$rinka.p(");
    expect(state.closed).toBe(true);
  });

  it("最初の値を待っている間に HTML のストリームの読み取りを中止すると、iterable を閉じる", async () => {
    const { iterable, calls } = recorded(["a"], 0);
    const Card = defineStreamed("x-st6", "s.tsx:6:1", () => iterable);
    const reader = renderToStream(
      jsx(Loading, { fallback: "loading", children: jsx(Card, {}) }),
    ).getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(calls).toEqual(["next", "return"]));
  });

  it("レスポンスを返さずに描画を終えたら、iterable の return を呼ぶ", async () => {
    const rendered = recorded(["a", "b"], 1);
    const failed = recorded(["a", "b"], 1);
    await renderToString(
      jsx(
        defineStreamed("x-st10", "s.tsx:10:1", () => rendered.iterable),
        {},
      ),
    );
    const Card = defineStreamed("x-st11", "s.tsx:11:1", () => failed.iterable);
    await expect(read(renderToStream([jsx(Card, {}), jsx(Thrower, {})]))).rejects.toThrow("shell");
    await vi.waitFor(() =>
      expect([rendered.calls, failed.calls]).toEqual([
        ["next", "return"],
        ["next", "return"],
      ]),
    );
  });

  it("最初の値を待っている間に HTML のストリームの読み取りを中止すると、描画したリクエストの Context の中で iterable の return を呼ぶ", async () => {
    const c = new Context(new Request("http://localhost/"));
    const seen = Promise.withResolvers<unknown>();
    const iterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => {
          seen.resolve(getContext());
          return { done: true, value: undefined };
        },
      }),
    };
    const Card = defineStreamed("x-st13", "s.tsx:13:1", () => iterable);
    const stream = await runInRequest(c, () =>
      renderToStream(jsx(Loading, { fallback: "loading", children: jsx(Card, {}) })),
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(await seen.promise).toBe(c);
  });
});
