import { afterEach, describe, expect, it, vi } from "vitest";

import { defineElement as defineClient } from "../../src/client/element.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/render.ts";
import { createElementComponent as defineServer } from "../../src/shared/element.ts";
import type { Ctx } from "../../src/shared/element.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $rinka?: unknown }).$rinka;
  vi.restoreAllMocks();
});

/** タグ名とプロパティから要素を作成する JSX の関数を表す。サーバーとクライアントで、同じ要素の関数を使用する。 */
type H = (type: unknown, props: Record<string, unknown>) => unknown;
const server = serverJsx as unknown as H;
const client = clientJsx as unknown as H;

let count = 0;
const nextTag = () => `test-start-${++count}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/** `node` をサーバーで描画し、起動スクリプトと `<head>` と本文のスクリプトを実行して、本文の HTML を body に配置する。 */
async function serve(node: unknown): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(node)) text += decoder.decode(chunk);
  run(bootstrapSource);
  const head = text.slice(text.indexOf("<head>"), text.indexOf("</head>"));
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const scripts: string[] = [];
  const markup = body.replaceAll(/<script>(.*?)<\/script>/gs, (_, script: string) => {
    scripts.push(script);
    return "";
  });
  const container = document.createElement("div");
  container.setHTMLUnsafe(markup);
  document.body.append(container);
  for (const [, script] of head.matchAll(/<script>(\$rinka\.m\(.*?)<\/script>/gs))
    run(script ?? "");
  scripts.forEach(run);
}

/** 起動した時点で、ホストに `data-started` を付与する要素の関数を作成する。 */
const startedView = (h: H) => (_props: object, ctx: Ctx) => {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return h("p", { children: "x" });
};

describe("SSR したインスタンスの起動", () => {
  it("同じタグのインスタンスのうち、起動の条件を満たしたものだけが起動し、満たしていないものは条件を満たすまで待つ", async () => {
    const callbacks: (() => void)[] = [];
    vi.spyOn(window, "requestIdleCallback").mockImplementation((callback) => {
      callbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 0 }));
      return 0;
    });
    const tag = nextTag();
    const Server = defineServer(
      tag,
      startedView(server),
      { props: [] },
      {
        module: "data:text/javascript,",
        load: "load",
      },
    );
    await serve(
      server("main", { children: [server(Server, {}), server(Server, { "load:idle": true })] }),
    );
    defineClient(tag, startedView(client), { props: [] });
    await tick();
    const [now, later] = document.querySelectorAll(tag);
    expect(now?.hasAttribute("data-started")).toBe(true);
    expect(later?.hasAttribute("data-started")).toBe(false);
    expect(later?.shadowRoot?.innerHTML).toBe("<p>x</p>");
    for (const callback of callbacks) callback();
    await tick();
    expect(later?.hasAttribute("data-started")).toBe(true);
  });

  it("起動スクリプトを読み込んでいないページでは、SSR したインスタンスもすぐに起動する", async () => {
    const tag = nextTag();
    const container = document.createElement("div");
    container.setHTMLUnsafe(
      `<${tag} data-oh="h1" data-rinka-load="idle"><template shadowrootmode="open"><p>x</p></template></${tag}>`,
    );
    document.body.append(container);
    defineClient(tag, startedView(client), { props: [] });
    await tick();
    expect(document.querySelector(tag)?.hasAttribute("data-started")).toBe(true);
  });
});

describe("Shadow DOM の中の子要素", () => {
  it("SSR した親の Shadow DOM の中の子要素は、起動スクリプトに起動の条件を問い合わせない", async () => {
    const inner = nextTag();
    const outer = nextTag();
    const delivery = { module: "data:text/javascript,", load: "idle" } as const;
    const InnerServer = defineServer(inner, startedView(server), { props: [] }, delivery);
    const OuterServer = defineServer(
      outer,
      () => server("div", { children: server(InnerServer, {}) }),
      { props: [] },
      { ...delivery, load: "load" },
    );
    await serve(server("main", { children: [server(OuterServer, {}), server(InnerServer, {})] }));
    const asked: string[] = [];
    const rinka = globalThis.$rinka!;
    const w = rinka.w.bind(rinka);
    vi.spyOn(rinka, "w").mockImplementation((el, f) => {
      asked.push(el.getRootNode() instanceof ShadowRoot ? "shadow" : "light");
      w(el, f);
    });
    defineClient(inner, startedView(client), { props: [] });
    await tick();
    expect(asked).toEqual(["light"]);
  });
});
