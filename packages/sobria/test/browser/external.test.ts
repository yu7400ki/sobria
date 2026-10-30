import { afterEach, describe, expect, it, vi } from "vitest";

import { Errored as ClientErrored } from "../../src/client/control.ts";
import { defineElement as defineClient } from "../../src/client/element.ts";
import { external as clientExternal } from "../../src/client/external.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { Errored as ServerErrored } from "../../src/server/control.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { external as serverExternal } from "../../src/server/external.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import type { External } from "../../src/shared/signals.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $sobria?: unknown }).$sobria;
  vi.restoreAllMocks();
});

/** タグ名とプロパティから要素を作成する JSX の関数を表す。サーバーとクライアントで、同じ要素の関数を使用する。 */
type H = (type: unknown, props: Record<string, unknown>) => unknown;

let count = 0;
const nextTag = () => `test-external-${++count}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ノードの、コメントを除いた HTML を返す。 */
const html = (node: Element | ShadowRoot | null | undefined) =>
  node?.innerHTML.replaceAll(/<!--[[\]]-->/g, "") ?? "";

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/** `node` をサーバーで描画し、起動スクリプトと値を送るスクリプトを実行して、本文の HTML を Declarative Shadow DOM として body に配置する。 */
async function serve(node: unknown): Promise<void> {
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
  scripts.forEach(run);
}

/** 通知する関数を登録し、購読している数を数える、外部の状態を表す。 */
function createStore(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    get: () => value,
    set: (next: string) => {
      value = next;
      for (const notify of listeners) notify();
    },
  };
}

/**
 * `store` の値を表示し、最初に読み取った値を `seen` に加える要素の関数を作成する。
 * `nested` が真なら、`external` を子のコンポーネントの中で呼ぶ。
 */
const view =
  (
    h: H,
    external: External,
    store: ReturnType<typeof createStore>,
    seen: string[],
    nested = false,
  ) =>
  () => {
    const content = () => {
      const read = external(store.subscribe, store.get, () => "server");
      seen.push(read());
      return h("p", { children: () => read() });
    };
    return nested ? h(content, {}) : content();
  };

describe("クライアントの external", () => {
  it("SSR していない要素では、最初から getSnapshot の値を使用し、通知で更新して、破棄で購読を解除する", async () => {
    const tag = nextTag();
    const store = createStore("a");
    const seen: string[] = [];
    defineClient(tag, view(clientJsx as unknown as H, clientExternal, store, seen), {
      props: {},
    });
    const host = document.createElement(tag);
    document.body.append(host);
    await tick();
    expect([seen, html(host.shadowRoot)]).toEqual([["a"], "<p>a</p>"]);
    expect(store.listeners.size).toBe(1);
    store.set("b");
    await tick();
    expect(html(host.shadowRoot)).toBe("<p>b</p>");
    host.remove();
    await tick();
    expect(store.listeners.size).toBe(0);
  });

  it.each([
    ["要素の関数", false],
    ["子のコンポーネント", true],
  ])(
    "SSR した要素の%sでは、getServerSnapshot の値で DOM を引き取ってから、getSnapshot の値に更新する",
    async (_, nested) => {
      const tag = nextTag();
      const store = createStore("client");
      const seen: string[] = [];
      await serve(
        (serverJsx as unknown as H)(
          defineServer(tag, view(serverJsx as unknown as H, serverExternal, store, [], nested), {
            props: {},
          }),
          {},
        ),
      );
      const warn = vi.spyOn(console, "warn");
      const host = document.querySelector(tag);
      const paragraph = host?.shadowRoot?.querySelector("p");
      expect(html(host?.shadowRoot)).toBe("<p>server</p>");
      defineClient(tag, view(clientJsx as unknown as H, clientExternal, store, seen, nested), {
        props: {},
      });
      await tick();
      expect(seen).toEqual(["server"]);
      expect(html(host?.shadowRoot)).toBe("<p>client</p>");
      expect(host?.shadowRoot?.querySelector("p")).toBe(paragraph);
      expect(warn).not.toHaveBeenCalled();
      store.set("next");
      await tick();
      expect(html(host?.shadowRoot)).toBe("<p>next</p>");
    },
  );

  it("SSR した子要素の DOM を引き取れずに作り直すときは、作り直す描画で getSnapshot の値を使用する", async () => {
    const outer = nextTag();
    const inner = nextTag();
    const store = createStore("client");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const sh = serverJsx as unknown as H;
    const ch = clientJsx as unknown as H;
    const serverInner = defineServer(inner, view(sh, serverExternal, store, []), { props: {} });
    await serve(
      sh(
        defineServer(outer, () => sh(serverInner, {}), { props: {} }),
        {},
      ),
    );
    const content = view(ch, clientExternal, store, seen);
    // サーバーが出力していない <u> を先頭に描画して、子要素の引き取りを失敗させる
    const clientInner = defineClient(inner, () => [ch("u", {}), content()], { props: {} });
    defineClient(outer, () => ch(clientInner, {}), { props: {} });
    await tick();
    const host = document.querySelector(outer)?.shadowRoot?.querySelector(inner);
    expect(seen).toEqual(["server", "client"]);
    expect(html(host?.shadowRoot)).toBe("<u></u><p>client</p>");
    expect(store.listeners.size).toBe(1);
  });
});

/** エラーを投げる。 */
const fail = () => {
  throw new Error("failed");
};

describe("<Errored> の中の external", () => {
  it.each([
    ["サーバーで中身が投げてフォールバックを出力した境界の中身", true],
    ["クライアントだけで中身が投げた境界のフォールバック", false],
  ])("%sは、getSnapshot の値で始まる", async (_, serverThrows) => {
    const tag = nextTag();
    const store = createStore("client");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const sh = serverJsx as unknown as H;
    const ch = clientJsx as unknown as H;
    const serverView = view(sh, serverExternal, store, []);
    const clientView = view(ch, clientExternal, store, seen);
    await serve(
      sh(
        defineServer(
          tag,
          () =>
            sh(ServerErrored, {
              fallback: () => sh("i", { children: "error" }),
              children: () => (serverThrows ? fail() : serverView()),
            }),
          { props: {} },
        ),
        {},
      ),
    );
    defineClient(
      tag,
      () =>
        ch(ClientErrored, {
          fallback: () => clientView(),
          children: () => (serverThrows ? clientView() : fail()),
        }),
      { props: {} },
    );
    await tick();
    expect(seen).toEqual(["client"]);
    expect(html(document.querySelector(tag)?.shadowRoot)).toBe("<p>client</p>");
  });
});
