import { afterEach, describe, expect, it, vi } from "vitest";

import { Loading as ClientLoading } from "../../src/client/control.ts";
import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { Loading as ServerLoading } from "../../src/server/control.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import { isSeeding, type MemoCompute } from "../../src/shared/scope.ts";
import { siteMemo as memo, signal } from "../../src/shared/signals.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $rinka?: unknown }).$rinka;
  vi.restoreAllMocks();
});

/** タグ名とプロパティから要素を作成する JSX の関数を表す。サーバーとクライアントで、同じ要素の関数を使用する。 */
type H = (type: unknown, props: Record<string, unknown>, key?: string, site?: string) => unknown;
const server = serverJsx as unknown as H;
const client = clientJsx as unknown as H;

let count = 0;
const nextTag = () => `test-take-${++count}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ノードの、コメントを除いた HTML を返す。 */
const html = (node: Element | ShadowRoot | null | undefined) =>
  node?.innerHTML.replaceAll(/<!--[[\]]-->/g, "") ?? "";

/** スクリプトの本文 `script` から、HTML のパーサーが読み取る本文を返す。 */
const parsedScript = (script: string) =>
  new DOMParser().parseFromString(`<script>${script}</script>`, "text/html").querySelector("script")
    ?.textContent ?? "";

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/**
 * `node` をサーバーで描画し、起動スクリプトを実行して、本文の HTML を Declarative Shadow DOM として body に配置する。
 * 起動スクリプト以外のスクリプト（値を送るスクリプト）の本文を返す。
 */
async function serve(node: unknown): Promise<string[]> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(node)) text += decoder.decode(chunk);
  run(bootstrapSource);
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const scripts: string[] = [];
  const markup = body.replaceAll(/<script>(.*?)<\/script>/gs, (_, script: string) => {
    scripts.push(script);
    return "";
  });
  const container = document.createElement("div");
  container.setHTMLUnsafe(markup);
  document.body.append(container);
  return scripts;
}

/** 呼び出し箇所 `site` の非同期の memo の値を、`label` を付けて表示する要素の関数を作成する。 */
function viewWith(h: H, label: string, site: string, fetch: () => Promise<string>) {
  return () => {
    const value = memo(fetch, { site });
    return h("p", { children: () => `${label} ${value()}` });
  };
}

/** `"ann"` に解決する Promise を返す。 */
const fetchAnn = () => Promise.resolve("ann");
/** 呼び出し箇所が `t:11` の memo を作成し、その値を読む。 */
const inner = () => memo(() => "row", { site: "t:11" })();

/** props の `data` の `name` を表示する要素の関数を作成する。 */
const dataView = (h: H) => (props: { data?: { name: string } }) =>
  h("p", { children: () => props.data?.name });

/** props の `open` が `false` のときだけ、`size` の型を `<i>` で表示する要素の関数を作成する。 */
const openView = (h: H) => (props: { open?: boolean; size?: unknown }) =>
  h("p", {
    children: () =>
      props.open === false ? h("i", { children: () => typeof props.size }) : h("b", {}),
  });

describe("値の引き継ぎ", () => {
  it("引き継いだ値で描画し、表示を変えずに、memo の取得を繰り返さない", async () => {
    const tag = nextTag();
    let fetched = 0;
    const fetch = () => {
      if (!isSeeding()) fetched++;
      return Promise.resolve("ann");
    };
    const scripts = await serve(
      server(defineServer(tag, viewWith(server, "", "t:1", fetch), { props: {} }), {}),
    );
    scripts.forEach(run);
    fetched = 0;
    defineClient(tag, viewWith(client, "", "t:1", fetch), { props: {} });
    await tick();
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p> ann</p>");
    expect(fetched).toBe(0);
  });

  it("シードで依存を登録し、依存が変化すると memo を計算し直す", async () => {
    const tag = nextTag();
    const [version, setVersion] = signal(0);
    const view = (h: H) => () => {
      const value = memo(
        () => {
          const current = version();
          return Promise.resolve(`v${current}`);
        },
        { site: "t:10" },
      );
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
    scripts.forEach(run);
    defineClient(tag, view(client), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>v0</p>");
    setVersion(1);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>v1</p>");
  });

  it.each([
    ["関数のコンポーネント", (h: H) => h(() => h("i", { children: inner() }), {}), "<i>row</i>"],
    ["サンク", (h: H) => h("i", { children: () => inner() }), "<i>row</i>"],
    ["属性の関数", (h: H) => h("i", { title: () => inner() }), '<i title="row"></i>'],
  ])(
    "%sの中の memo にはキーを付けず、要素の関数の中の memo の回数をずらさない",
    async (_, row, expected) => {
      const tag = nextTag();
      let fetched = 0;
      const fetch = () => {
        if (!isSeeding()) fetched++;
        return Promise.resolve("direct");
      };
      const view = (h: H) => () => {
        const first = row(h);
        const direct = memo(fetch, { site: "t:11" });
        return [first, h("p", { children: () => direct() })];
      };
      const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
      scripts.forEach(run);
      fetched = 0;
      defineClient(tag, view(client), { props: {} });
      await tick();
      expect(html(document.querySelector(tag)?.shadowRoot)).toBe(`${expected}<p>direct</p>`);
      expect(fetched).toBe(0);
    },
  );

  it("data-om の値がすべて届くまで起動しない", async () => {
    const tag = nextTag();
    const scripts = await serve(
      server(defineServer(tag, viewWith(server, "server", "t:2", fetchAnn), { props: {} }), {}),
    );
    defineClient(tag, viewWith(client, "client", "t:2", fetchAnn), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>server ann</p>");
    scripts.forEach(run);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>client ann</p>");
  });

  it("新しい描画が保留中の間は、SSR した表示を残す", async () => {
    const tag = nextTag();
    await serve(
      server(
        defineServer(tag, () => server("p", { children: "ssr" }), { props: {} }),
        {},
      ),
    );
    const { promise, resolve } = Promise.withResolvers<string>();
    defineClient(
      tag,
      () => {
        const value = memo(() => promise);
        return client("p", { children: () => value() });
      },
      { props: {} },
    );
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>ssr</p>");
    resolve("client");
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>client</p>");
  });

  it("値が無いキーの memo は、ブラウザで計算し直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tag = nextTag();
    /** シリアライズできない値である。 */
    class Unserializable {
      toString() {
        return "ssr";
      }
    }
    const scripts = await serve(
      server(
        defineServer(
          tag,
          viewWith(server, "", "t:3", () => Promise.resolve(new Unserializable() as never)),
          { props: {} },
        ),
        {},
      ),
    );
    scripts.forEach(run);
    let fetched = 0;
    defineClient(
      tag,
      viewWith(client, "", "t:3", () => {
        fetched++;
        return Promise.resolve("again");
      }),
      { props: {} },
    );
    await tick();
    await tick();
    expect(fetched).toBe(1);
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p> again</p>");
  });

  it("サーバーで失敗した memo は、ブラウザで計算し直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tag = nextTag();
    const scripts = await serve(
      server(
        defineServer(
          tag,
          () => {
            const view = viewWith(server, "", "t:3f", () => Promise.reject(new Error("e")));
            return server(ServerLoading, { fallback: "", children: () => view() });
          },
          { props: {} },
        ),
        {},
      ),
    );
    scripts.forEach(run);
    let fetched = 0;
    defineClient(
      tag,
      () => {
        const view = viewWith(client, "", "t:3f", () => {
          fetched++;
          return Promise.resolve("again");
        });
        return client(ClientLoading, { fallback: "", children: () => view() });
      },
      { props: {} },
    );
    await tick();
    await tick();
    expect(fetched).toBe(1);
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p> again</p>");
  });

  it("使用しなかった値を、開発時に警告する", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tag = nextTag();
    const scripts = await serve(
      server(defineServer(tag, viewWith(server, "", "t:4", fetchAnn), { props: {} }), {}),
    );
    scripts.forEach(run);
    defineClient(tag, viewWith(client, "", "t:other", fetchAnn), { props: {} });
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("t:4#0");
  });

  it("属性にできない props を、引き継いでプロパティに設定する", async () => {
    const tag = nextTag();
    const scripts = await serve(
      server(defineServer(tag, dataView(server), { props: { data: "unknown" } }), {
        data: { name: "ann" },
      }),
    );
    scripts.forEach(run);
    defineClient(tag, dataView(client), { props: { data: "unknown" } });
    await tick();
    const host = document.querySelector(tag) as (HTMLElement & { data?: unknown }) | null;
    expect(html(host?.shadowRoot)).toBe("<p>ann</p>");
    expect(host?.data).toEqual({ name: "ann" });
  });

  it("引き継いだ props を読む領域は、引き取った後に実行し直さない", async () => {
    const tag = nextTag();
    let runs = 0;
    const view = (h: H) => (props: { data?: { name: string } }) =>
      h("p", {
        children: () => {
          runs++;
          return h("i", { children: props.data?.name });
        },
      });
    const scripts = await serve(
      server(defineServer(tag, view(server), { props: { data: "object" } }), {
        data: { name: "ann" },
      }),
    );
    scripts.forEach(run);
    const host = document.querySelector(tag);
    const node = host?.shadowRoot?.querySelector("i");
    runs = 0;
    defineClient(tag, view(client), { props: { data: "object" } });
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p><i>ann</i></p>");
    expect(host?.shadowRoot?.querySelector("i")).toBe(node);
    expect(runs).toBe(1);
  });

  it("属性の文字列から元の値に戻せない props は、サーバーと同じ値で受け取り、DOM を引き取る", async () => {
    const tag = nextTag();
    const kinds = { props: { open: "boolean", size: "unknown" } } as const;
    const warn = vi.spyOn(console, "warn");
    const scripts = await serve(
      server(defineServer(tag, openView(server), kinds), { open: false, size: 1 }),
    );
    const host = document.querySelector(tag) as (HTMLElement & { size?: unknown }) | null;
    const node = host?.shadowRoot?.querySelector("i");
    scripts.forEach(run);
    defineClient(tag, openView(client), kinds);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p><i>number</i></p>");
    expect(host?.shadowRoot?.querySelector("i")).toBe(node);
    expect(host?.size).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([["a\r\nb"], ["a\u0000b"], ["a\uD800b"]])(
    "ページに出力すると置き換わる文字を含む文字列 %j も、同じ値で受け取る",
    async (label) => {
      const tag = nextTag();
      const kinds = { props: { label: "string" } } as const;
      const scripts = await serve(
        server(
          defineServer(tag, () => null, kinds),
          { label },
        ),
      );
      scripts.forEach((script) => run(parsedScript(script)));
      defineClient(tag, () => null, kinds);
      await tick();
      expect((document.querySelector(tag) as { label?: unknown } | null)?.label).toBe(label);
    },
  );
});

describe("Shadow DOM の中の子要素", () => {
  it("起動していない SSR した親の中の子要素は、自分で起動せず、親が引き取って起動する", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    const childServer = defineServer(childTag, viewWith(server, "server", "t:5", fetchAnn), {
      props: {},
    });
    const scripts = await serve(
      server(
        defineServer(parentTag, () => server(childServer, {}), { props: {} }),
        {},
      ),
    );
    const childClient = defineClient(childTag, viewWith(client, "client", "t:5", fetchAnn), {
      props: {},
    });
    await tick();
    const ssrChild = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(html(ssrChild?.shadowRoot)).toBe("<p>server ann</p>");
    scripts.forEach(run);
    defineClient(parentTag, () => client(childClient, {}), { props: {} });
    await tick();
    await tick();
    const child = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(child).toBe(ssrChild);
    expect(html(child?.shadowRoot)).toBe("<p>client ann</p>");
  });
});

describe("Shadow DOM の中の子要素（親の描画が保留中か、起動し直した後）", () => {
  it("親が SSR した中身をまだ置き換えていない間は、値が届いても子要素は起動しない", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    const childServer = defineServer(childTag, viewWith(server, "", "t:9", fetchAnn), {
      props: {},
    });
    const scripts = await serve(
      server(
        defineServer(parentTag, () => server(childServer, {}), { props: {} }),
        {},
      ),
    );
    let rendered = 0;
    const childClient = defineClient(
      childTag,
      () => {
        rendered++;
        return client("p", { children: "child" });
      },
      { props: {} },
    );
    const { promise, resolve } = Promise.withResolvers<string>();
    defineClient(
      parentTag,
      () => {
        const pending = memo(() => promise);
        return [client("i", { children: () => pending() }), client(childClient, {})];
      },
      { props: {} },
    );
    await tick();
    scripts.forEach(run);
    await tick();
    resolve("p");
    await tick();
    expect(rendered).toBe(1);
  });

  it("最初の起動が保留中のまま切断され、起動し直した親の Shadow DOM に追加した要素は、最上位として起動する", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    await serve(
      server(
        defineServer(parentTag, () => server("p", { children: "ssr" }), { props: {} }),
        {},
      ),
    );
    let rendered = 0;
    defineClient(
      childTag,
      () => {
        rendered++;
        return null;
      },
      { props: {} },
    );
    const { promise, resolve } = Promise.withResolvers<string>();
    defineClient(
      parentTag,
      () => {
        const pending = memo(() => promise);
        return client("p", { children: () => pending() });
      },
      { props: {} },
    );
    await tick();
    const host = document.querySelector(parentTag);
    const container = host?.parentElement;
    host?.remove();
    await tick();
    if (host) container?.append(host);
    await tick();
    resolve("client");
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>client</p>");
    host?.shadowRoot?.append(document.createElement(childTag));
    await tick();
    expect(rendered).toBe(1);
  });

  it("最初の描画が保留中のまま起動し直した要素は、サーバーの値を引き継がずに計算する", async () => {
    const tag = nextTag();
    const scripts = await serve(
      server(defineServer(tag, viewWith(server, "", "t:20", fetchAnn), { props: {} }), {}),
    );
    scripts.forEach(run);
    let fetched = 0;
    const fetch = () => {
      if (!isSeeding()) fetched++;
      return Promise.resolve("cli");
    };
    const { promise, resolve } = Promise.withResolvers<string>();
    defineClient(
      tag,
      () => {
        const value = memo(fetch, { site: "t:20" });
        const pending = memo(() => promise);
        return client("p", { children: () => `${value()} ${pending()}` });
      },
      { props: {} },
    );
    await tick();
    const host = document.querySelector(tag);
    const container = host?.parentElement;
    host?.remove();
    await tick();
    if (host) container?.append(host);
    await tick();
    resolve("p");
    await tick();
    expect(fetched).toBe(1);
    expect(html(host?.shadowRoot)).toBe("<p>cli p</p>");
  });
});

describe("入れ子の子要素の引き継ぎ", () => {
  it("親が作り直した子要素は、同じキーの子要素のホストの値を引き継ぐ", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    let fetched = 0;
    const fetch = () => {
      if (!isSeeding()) fetched++;
      return Promise.resolve("ann");
    };
    const childServer = defineServer(childTag, viewWith(server, "", "t:7", fetch), { props: {} });
    const scripts = await serve(
      server(
        defineServer(parentTag, () => server(childServer, {}, undefined, "p:1"), { props: {} }),
        {},
      ),
    );
    scripts.forEach(run);
    fetched = 0;
    const childClient = defineClient(childTag, viewWith(client, "", "t:7", fetch), { props: {} });
    defineClient(parentTag, () => client(childClient, {}, undefined, "p:1"), { props: {} });
    await tick();
    const child = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(html(child?.shadowRoot)).toBe("<p> ann</p>");
    expect(fetched).toBe(0);
  });

  it("親は、値を引き継ぐ子要素のホストの値も届くまで起動しない", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    const childServer = defineServer(childTag, viewWith(server, "", "t:8", fetchAnn), {
      props: {},
    });
    const scripts = await serve(
      server(
        defineServer(parentTag, () => server(childServer, {}, undefined, "p:2"), { props: {} }),
        {},
      ),
    );
    const own = scripts.filter((script) => script.startsWith('$rinka.d("h1"'));
    const rest = scripts.filter((script) => !own.includes(script));
    own.forEach(run);
    const childClient = defineClient(childTag, viewWith(client, "client", "t:8", fetchAnn), {
      props: {},
    });
    defineClient(parentTag, () => client(childClient, {}, undefined, "p:2"), { props: {} });
    await tick();
    const ssrChild = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(html(ssrChild?.shadowRoot)).toBe("<p> ann</p>");
    rest.forEach(run);
    await tick();
    const child = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(child).toBe(ssrChild);
    expect(html(child?.shadowRoot)).toBe("<p>client ann</p>");
  });

  it("子要素のホストの ID が後から届いても、その子要素のホストの値を待つ", async () => {
    const parentTag = nextTag();
    const childTag = nextTag();
    const childServer = defineServer(childTag, viewWith(server, "", "t:12", fetchAnn), {
      props: {},
    });
    const scripts = await serve(
      server(
        defineServer(parentTag, () => server(childServer, {}, undefined, "p:4"), { props: {} }),
        {},
      ),
    );
    const mapping = scripts.filter((script) => script.includes("@c:"));
    const childValues = scripts.filter((script) => script.startsWith('$rinka.d("h2"'));
    const childClient = defineClient(childTag, viewWith(client, "client", "t:12", fetchAnn), {
      props: {},
    });
    defineClient(parentTag, () => client(childClient, {}, undefined, "p:4"), { props: {} });
    await tick();
    mapping.forEach(run);
    await tick();
    const ssrChild = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(html(ssrChild?.shadowRoot)).toBe("<p> ann</p>");
    childValues.forEach(run);
    await tick();
    const child = document.querySelector(parentTag)?.shadowRoot?.querySelector(childTag);
    expect(child).toBe(ssrChild);
    expect(html(child?.shadowRoot)).toBe("<p>client ann</p>");
  });
});

/** 値を送るスクリプトのうち、キー `key` の値を、`$rinka.s` で作成したストリームの記録に置き換える。 */
const streamed = (scripts: string[], key: string) =>
  scripts.map((script) =>
    !script.includes(JSON.stringify(key))
      ? script
      : script
          .replace(`{${JSON.stringify(key)}:`, `{${JSON.stringify(key)}:$rinka.s(`)
          .replace(/\}\)$/, ")})"),
  );

/** 呼び出し箇所が `t:20` の memo の値を表示する要素の関数を作成する。memo の関数は `fetch` を呼ぶ。 */
const streamView = (h: H, fetch: MemoCompute<string>) => () => {
  const value = memo(fetch, { site: "t:20" });
  return h("p", { children: () => value() });
};

/** `"a"` に解決する Promise を返す。 */
const fetchA = () => Promise.resolve("a");

/** `send` で渡した値を順に yield する async iterable を返す `values` と、`send` の組を作成する。 */
function channel<T>() {
  const pending: PromiseWithResolvers<T>[] = [Promise.withResolvers<T>()];
  async function* values(): AsyncGenerator<T> {
    for (let i = 0; ; i++) {
      // oxlint-disable-next-line no-await-in-loop
      yield await pending[i]!.promise;
    }
  }
  const send = (value: T) => {
    pending.at(-1)!.resolve(value);
    pending.push(Promise.withResolvers<T>());
  };
  return { values, send };
}

describe("ストリームの値の引き継ぎ", () => {
  it("引き継いだ値で起動し、起動した時点で memo の関数を 1 回実行し、memo の関数が返した async iterable の値で memo を置き換える", async () => {
    const tag = nextTag();
    const source = channel<string>();
    const pending = Promise.withResolvers<AsyncIterable<string>>();
    const seeding: boolean[] = [];
    const fetch = () => {
      seeding.push(isSeeding());
      return pending.promise;
    };
    const scripts = await serve(
      server(defineServer(tag, streamView(server, fetchA), { props: {} }), {}),
    );
    streamed(scripts, "t:20#0").forEach(run);
    defineClient(tag, streamView(client, fetch), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>a</p>");
    pending.resolve(source.values());
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>a</p>");
    source.send("b");
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>b</p>");
    source.send("c");
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>c</p>");
    expect(seeding).toEqual([false]);
  });

  it("起動した要素の関数の中で、引き継いだストリームの memo を読み取っても、保留中にならない", async () => {
    const tag = nextTag();
    const read: string[] = [];
    const view = (h: H, record: boolean, fetch: () => Promise<string>) => () => {
      const value = memo(fetch, { site: "t:20" });
      if (record && read.length === 0) {
        try {
          read.push(value());
        } catch {
          read.push("pending");
        }
      }
      return h("p", { children: () => value() });
    };
    const scripts = await serve(
      server(defineServer(tag, view(server, false, fetchA), { props: {} }), {}),
    );
    streamed(scripts, "t:20#0").forEach(run);
    defineClient(
      tag,
      view(client, true, () => new Promise(() => {})),
      { props: {} },
    );
    await tick();
    expect(read).toEqual(["a"]);
  });

  it("依存が変化すると、引き継いだストリームの memo の関数をブラウザで実行し直す", async () => {
    const tag = nextTag();
    const [version, setVersion] = signal(0);
    const view = (h: H) => () => {
      const value = memo(
        () => {
          const current = version();
          return Promise.resolve(`v${current}`);
        },
        { site: "t:21" },
      );
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
    streamed(scripts, "t:21#0").forEach(run);
    defineClient(tag, view(client), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>v0</p>");
    setVersion(1);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>v1</p>");
  });
});
