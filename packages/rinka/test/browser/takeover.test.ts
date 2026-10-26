import { afterEach, describe, expect, it, vi } from "vitest";

import { Loading as ClientLoading } from "../../src/client/control.ts";
import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { Loading as ServerLoading } from "../../src/server/control.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import { isSeeding } from "../../src/shared/scope.ts";
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

/** 値を送るスクリプトのうち、キー `key` の値を、`$rinka.s` で作成したストリームに置き換える。 */
const streamed = (scripts: string[], key: string) =>
  scripts.map((script) =>
    !script.includes(JSON.stringify(key))
      ? script
      : script
          .replace(`{${JSON.stringify(key)}:`, `{${JSON.stringify(key)}:$rinka.s(`)
          .replace(/\}\)$/, ")})"),
  );

/** 値を送るスクリプトから、キー `key` の値を送ったホストの ID を返す。 */
const hostOf = (scripts: string[], key: string) => {
  const script = scripts.find((s) => s.includes(JSON.stringify(key)));
  return JSON.parse(/^\$rinka\.d\(("[^"]*")/.exec(script ?? "")?.[1] ?? '""') as string;
};

/** 呼び出し箇所が `t:20` の memo の値を表示する要素の関数を作成する。memo の関数は `fetch` を呼ぶ。 */
const streamView = (h: H, fetch: () => Promise<string>) => () => {
  const value = memo(fetch, { site: "t:20" });
  return h("p", { children: () => value() });
};

/** `"a"` と `"b"` を yield する。 */
async function* letters() {
  yield "a";
  yield "b";
}

/** `"a"` に解決する Promise を返す。 */
const fetchA = () => Promise.resolve("a");

/** サーバーのストリームの失敗を伝える未処理の例外だけを、報告しないようにする。 */
const ignoreStreamFailure = (event: ErrorEvent | PromiseRejectionEvent) => {
  const error: unknown = event instanceof ErrorEvent ? event.error : event.reason;
  if (error instanceof Error && error.message.startsWith("サーバーで memo")) event.preventDefault();
};

describe("ストリームの値の引き継ぎ", () => {
  it("引き継いだ最新の値で起動し、後から届いた値で memo を置き換え、memo の取得を繰り返さない", async () => {
    const tag = nextTag();
    let fetched = 0;
    const fetch = () => {
      if (!isSeeding()) fetched++;
      return Promise.resolve("a");
    };
    const scripts = await serve(
      server(defineServer(tag, streamView(server, fetch), { props: {} }), {}),
    );
    const id = hostOf(scripts, "t:20#0");
    streamed(scripts, "t:20#0").forEach(run);
    run(`$rinka.p(${JSON.stringify(id)},"t:20#0",0,"b")`);
    fetched = 0;
    defineClient(tag, streamView(client, fetch), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>b</p>");
    run(`$rinka.p(${JSON.stringify(id)},"t:20#0",0,"c")`);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>c</p>");
    run(`$rinka.p(${JSON.stringify(id)},"t:20#0",1)`);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>c</p>");
    expect(fetched).toBe(0);
  });

  it("起動した要素の関数の中で、引き継いだストリームの memo を読み取っても、保留中にならない", async () => {
    const tag = nextTag();
    const read: string[] = [];
    const view = (h: H, record: boolean) => () => {
      const value = memo(fetchA, { site: "t:20" });
      if (record && read.length === 0) {
        try {
          read.push(value());
        } catch {
          read.push("pending");
        }
      }
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server, false), { props: {} }), {}));
    const id = hostOf(scripts, "t:20#0");
    streamed(scripts, "t:20#0").forEach(run);
    run(`$rinka.p(${JSON.stringify(id)},"t:20#0",0,"b")`);
    defineClient(tag, view(client, true), { props: {} });
    await tick();
    expect(read).toEqual(["b"]);
  });

  it("サーバーの memo が返した async iterable の値をすべて受け取ってから起動すると、最後の値で起動し、memo の取得を繰り返さない", async () => {
    const tag = nextTag();
    let fetched = 0;
    const view = (h: H) => () => {
      const value = memo(
        () => {
          if (!isSeeding()) fetched++;
          return letters();
        },
        { site: "t:23" },
      );
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
    expect(scripts.some((script) => script.includes("$rinka.s("))).toBe(true);
    scripts.forEach(run);
    fetched = 0;
    defineClient(tag, view(client), { props: {} });
    await tick();
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p>b</p>");
    expect(fetched).toBe(0);
  });

  it("サーバーの memo が async iterable に解決する Promise を返しても、最初の値で描画し、続きの値を送る", async () => {
    const tag = nextTag();
    let fetched = 0;
    const view = (h: H) => () => {
      const value = memo(
        () => {
          if (!isSeeding()) fetched++;
          return Promise.resolve(letters());
        },
        { site: "t:22" },
      );
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
    scripts.forEach(run);
    fetched = 0;
    defineClient(tag, view(client), { props: {} });
    await tick();
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p>b</p>");
    expect(fetched).toBe(0);
  });

  it("起動する前にストリームが終わっていれば、最後の値で起動する", async () => {
    const tag = nextTag();
    const scripts = await serve(
      server(defineServer(tag, streamView(server, fetchA), { props: {} }), {}),
    );
    const id = hostOf(scripts, "t:20#0");
    streamed(scripts, "t:20#0").forEach(run);
    run(
      `$rinka.p(${JSON.stringify(id)},"t:20#0",0,"z");$rinka.p(${JSON.stringify(id)},"t:20#0",1)`,
    );
    defineClient(tag, streamView(client, fetchA), { props: {} });
    await tick();
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p>z</p>");
  });

  it("依存が変化すると、引き継いだストリームの値を使わずに、memo の関数をブラウザで実行する", async () => {
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
    const id = hostOf(scripts, "t:21#0");
    streamed(scripts, "t:21#0").forEach(run);
    defineClient(tag, view(client), { props: {} });
    await tick();
    const host = document.querySelector(tag);
    expect(html(host?.shadowRoot)).toBe("<p>v0</p>");
    setVersion(1);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>v1</p>");
    run(`$rinka.p(${JSON.stringify(id)},"t:21#0",0,"stale")`);
    await tick();
    expect(html(host?.shadowRoot)).toBe("<p>v1</p>");
  });

  it("サーバーの iterable が失敗したら、memo を読み取ると例外を投げる", async () => {
    const tag = nextTag();
    let read: (() => string) | undefined;
    const view = (h: H) => () => {
      const value = memo(fetchA, { site: "t:20" });
      read = value;
      return h("p", { children: () => value() });
    };
    const scripts = await serve(server(defineServer(tag, view(server), { props: {} }), {}));
    const id = hostOf(scripts, "t:20#0");
    streamed(scripts, "t:20#0").forEach(run);
    defineClient(tag, view(client), { props: {} });
    await tick();
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p>a</p>");
    // 失敗を受け止める境界が無いので、@solidjs/signals は memo の失敗を未処理の例外として報告する。
    window.addEventListener("error", ignoreStreamFailure);
    window.addEventListener("unhandledrejection", ignoreStreamFailure);
    run(`$rinka.p(${JSON.stringify(id)},"t:20#0",2)`);
    await tick();
    expect(() => read?.()).toThrow("サーバーで memo の値を取得できませんでした。");
    await tick();
    window.removeEventListener("error", ignoreStreamFailure);
    window.removeEventListener("unhandledrejection", ignoreStreamFailure);
  });
});
