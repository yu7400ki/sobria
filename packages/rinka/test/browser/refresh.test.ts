import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineElement as defineClient } from "../../src/client/element.ts";
import { listenForms } from "../../src/client/form.ts";
import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { applyRefresh, refreshPage } from "../../src/client/refresh.ts";
import { serverFn } from "../../src/client/server-fn.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderRefresh, renderToStream } from "../../src/server/response.ts";
import type { Ctx, ElementOptions } from "../../src/shared/element.ts";
import type { RefreshJson } from "../../src/shared/refresh.ts";
import { action, memo, optimistic, refresh, signal, wait } from "../../src/shared/signals.ts";
import { wireFormat, wireHeader } from "../../src/shared/wire.ts";

/** テストの前の `<head>` の子と、文書のタイトルである。 */
let headBefore: Element[] = [];
let titleBefore = "";

beforeEach(() => {
  headBefore = [...document.head.children];
  titleBefore = document.title;
});

afterEach(() => {
  document.body.replaceChildren();
  for (const child of Array.from(document.head.children))
    if (!headBefore.includes(child)) child.remove();
  document.title = titleBefore;
  for (const name of document.documentElement.getAttributeNames()) {
    document.documentElement.removeAttribute(name);
  }
  for (const name of document.body.getAttributeNames()) document.body.removeAttribute(name);
  delete (globalThis as { $rinka?: unknown }).$rinka;
  vi.restoreAllMocks();
});

/** タグ名とプロパティから要素を作成する JSX の関数を表す。サーバーとクライアントで、同じ要素の関数を使用する。 */
type H = (type: unknown, props: Record<string, unknown>, key?: string, site?: string) => unknown;
const server = serverJsx as unknown as H;
const client = clientJsx as unknown as H;

let count = 0;
const nextTag = () => `test-refresh-${++count}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** スクリプトの本文を実行する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const run = (script: string) => new Function(script)();

/** `node` をサーバーで描画し、起動スクリプトと値を送るスクリプトを実行して、本文を body に配置する。 */
async function serve(node: unknown): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(node)) text += decoder.decode(chunk);
  run(bootstrapSource);
  const scripts: string[] = [];
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const markup = body.replaceAll(/<script>(.*?)<\/script>/gs, (_, script: string) => {
    scripts.push(script);
    return "";
  });
  document.body.setHTMLUnsafe(markup);
  scripts.forEach(run);
}

/** `json` の一部を指定した、描き直しのレスポンスの JSON を返す。 */
const refreshJson = (json: Partial<RefreshJson>): RefreshJson => ({
  head: "",
  body: "",
  data: {},
  elements: [],
  doc: { html: {}, body: {} },
  ...json,
});

/** props の `label` と `data` の `name` と、ボタンを押した回数を表示する要素の関数を作成する。 */
const counterView = (h: H) => (props: { label?: string; data?: { name: string } }) => {
  const [clicks, setClicks] = signal(0);
  return h("button", {
    onClick: () => setClicks((value) => value + 1),
    children: () => `${props.label} ${props.data?.name} ${clicks()}`,
  });
};

describe("applyRefresh", () => {
  it("<title> を置換し、キーが同じタグを置換し、ページに無いタグを加え、描き直しに無いタグを残す", () => {
    run(bootstrapSource);
    document.head.insertAdjacentHTML(
      "beforeend",
      '<meta name="description" content="old"><meta name="keep" content="k">',
    );
    const json = refreshJson({
      head: '<title>new</title><meta name="description" content="new"><link rel="stylesheet" href="/x.css">',
    });
    applyRefresh(json);
    applyRefresh(json);
    expect(document.title).toBe("new");
    expect(
      [...document.head.querySelectorAll('meta[name="description"]')].map((meta) =>
        meta.getAttribute("content"),
      ),
    ).toEqual(["new"]);
    expect(document.head.querySelector('meta[name="keep"]')).not.toBeNull();
    expect(document.head.querySelectorAll('link[href="/x.css"]')).toHaveLength(1);
  });

  it("<html> と <body> の属性を設定し、前回の描き直しで設定して今回の描き直しで設定しない属性を削除する", () => {
    run(bootstrapSource);
    applyRefresh(
      refreshJson({
        doc: { html: { lang: "ja", "data-x": "1" }, body: { "data-a": "" } },
      }),
    );
    expect(document.documentElement.getAttribute("lang")).toBe("ja");
    expect(document.body.getAttribute("data-a")).toBe("");
    document.body.classList.add("theme");
    applyRefresh(refreshJson({ doc: { html: { lang: "en" }, body: {} } }));
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.documentElement.hasAttribute("data-x")).toBe(false);
    expect(document.body.hasAttribute("data-a")).toBe(false);
    expect(document.body.getAttribute("class")).toBe("theme");
  });

  it("<head> に加える <script> を実行する", () => {
    run(bootstrapSource);
    applyRefresh(refreshJson({ head: "<script>globalThis.refreshedHead = true</script>" }));
    expect((globalThis as { refreshedHead?: boolean }).refreshedHead).toBe(true);
    delete (globalThis as { refreshedHead?: boolean }).refreshedHead;
  });

  it("rinka のサーバーが描画していないページでは、エラーを投げる", () => {
    expect(() => applyRefresh(refreshJson({}))).toThrow("refreshPage()");
  });

  it("ページにある要素は状態を保ったまま新しい props を受け取り、新しく現れた要素は描き直しの props で起動する", async () => {
    const tag = nextTag();
    const options: ElementOptions = { props: { label: "unknown", data: "unknown" } };
    const element = defineServer(tag, counterView(server), options);
    const page = (...cards: [string, string][]) =>
      server("main", {
        children: cards.map(([label, name]) => server(element, { label, data: { name } })),
      });
    await serve(page(["a", "ann"]));
    defineClient(tag, counterView(client), options);
    await tick();
    const first = document.querySelector(tag);
    first?.shadowRoot?.querySelector("button")?.click();
    await tick();
    expect(first?.shadowRoot?.textContent).toBe("a ann 1");

    const response = await renderRefresh(page(["b", "bob"], ["c", "cy"]));
    const json = (await response.json()) as RefreshJson;
    applyRefresh(json);
    await tick();
    const [keptId, addedId] = Object.keys(json.data);
    expect(globalThis.$rinka?.v[keptId ?? ""]).toBeUndefined();
    expect(globalThis.$rinka?.v[addedId ?? ""]).toBeDefined();
    const [kept, added] = document.querySelectorAll(tag);
    expect(kept).toBe(first);
    expect(kept?.shadowRoot?.textContent).toBe("b bob 1");
    expect(added?.shadowRoot?.textContent).toBe("c cy 0");
  });

  it("ページにある要素の props のうち、描き直しで値が変わらない props を読み取った計算は、再び実行しない", async () => {
    const tag = nextTag();
    const options: ElementOptions = { props: { label: "string" } };
    let calls = 0;
    const view = (h: H) => (props: { label: string }) => {
      const upper = memo(() => {
        calls++;
        return props.label.toUpperCase();
      });
      return h("span", { children: () => upper() });
    };
    const element = defineServer(tag, view(server), options);
    const page = (label: string) => server("main", { children: server(element, { label }) });
    await serve(page("a"));
    defineClient(tag, view(client), options);
    await tick();
    const started = calls;

    applyRefresh((await (await renderRefresh(page("a"))).json()) as RefreshJson);
    await tick();
    expect(calls).toBe(started);

    applyRefresh((await (await renderRefresh(page("b"))).json()) as RefreshJson);
    await tick();
    expect(calls).toBe(started + 1);
    expect(document.querySelector(tag)?.shadowRoot?.textContent).toBe("B");
  });

  it("action の中で、props の値が変わらない描き直しを反映した後に refresh(memo) を yield で待つと、action が終わる", async () => {
    const tag = nextTag();
    const options: ElementOptions = { props: { id: "number" } };
    let send: (() => Promise<void>) | undefined;
    const view = (h: H) => (props: { id: number }) => {
      const user = memo(async () => ({ likes: props.id }));
      const [likes, setLikes] = optimistic(() => user().likes);
      send = action(function* () {
        setLikes(likes() + 1);
        yield tick();
        const response = yield* wait(renderRefresh(page(1)));
        applyRefresh((yield* wait(response.json())) as RefreshJson);
        yield new Promise((resolve) => setTimeout(resolve, 20));
        yield refresh(user);
      });
      return h("span", { children: () => String(likes()) });
    };
    const element = defineServer(tag, view(server), options);
    const page = (id: number) => server("main", { children: server(element, { id }) });
    await serve(page(1));
    defineClient(tag, view(client), options);
    await tick();

    const timeout = new Promise((resolve) => setTimeout(resolve, 500, "timeout"));
    expect(await Promise.race([send?.().then(() => "done"), timeout])).toBe("done");
  });
});

/** window に届いた submit のイベントで、ページを移動しないようにする。 */
const block = (event: Event) => event.preventDefault();
/** フォームの部品の要素と、ネイティブの部品の値を `value` にしたフォームのページを返す。`key` はフォームのキーである。 */
const formPage = (element: unknown, value: string, key = "f") =>
  server("main", {
    children: server(
      "form",
      {
        action: serverFn("src/form-test.ts#save", "POST"),
        method: "post",
        children: [
          server(element, { name: "body", content: value }),
          server("input", { name: "text", value }),
          server("textarea", { name: "note", value }),
          server("select", {
            name: "choice",
            value,
            children: ["old", "new"].map((option) =>
              server("option", { value: option, children: option }),
            ),
          }),
          server("input", { type: "checkbox", name: "check", checked: value === "new" }),
          server("button", { children: "go" }),
        ],
      },
      key,
    ),
  });

/** `form.onReset` で props の `content` を値にし、読んだ `content` を `resets` に記録するフォームの部品を返す。 */
const fieldView =
  (h: H, resets: string[]) =>
  (props: { content?: string }, { form }: Ctx) => {
    const [value, setValue] = signal(props.content ?? "");
    form.value(() => value());
    form.onReset(() => {
      resets.push(props.content ?? "");
      setValue(props.content ?? "");
    });
    return h("span", {});
  };

/** `old` のページを配置して起動し、送信の後に `next` のページへ描き直すレスポンスを返すようにする。 */
async function submitted(next: (element: unknown) => unknown) {
  const tag = nextTag();
  const resets: string[] = [];
  const options: ElementOptions = { props: { content: "string" }, form: true };
  const element = defineServer(tag, fieldView(server, resets), options);
  await serve(formPage(element, "old"));
  defineClient(tag, fieldView(client, resets), options);
  await tick();
  const json = (await (await renderRefresh(next(element))).json()) as RefreshJson;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { redirect: `${location.pathname}${location.search}`, page: json },
      { headers: { [wireHeader]: wireFormat.rpc } },
    ),
  );
  return resets;
}

/** フォームの値を、名前と値の組の配列で返す。 */
const entries = () => [...new FormData(document.querySelector("form")!)];

describe("フォームを送信した後の描き直し", () => {
  beforeEach(() => {
    listenForms();
    window.addEventListener("submit", block);
  });
  afterEach(() => window.removeEventListener("submit", block));

  it("移動先が現在のページなら、描き直しの結果を反映してからフォームをリセットするので、onReset は新しい props を読む", async () => {
    const resets = await submitted((element) => formPage(element, "new"));
    document.querySelector<HTMLInputElement>('input[name="text"]')!.value = "typed";
    document.querySelector<HTMLTextAreaElement>("textarea")!.value = "typed";
    document.querySelector<HTMLSelectElement>("select")!.value = "old";
    document.querySelector<HTMLInputElement>('input[name="check"]')!.checked = false;
    document.querySelector("button")!.click();
    await vi.waitFor(() => expect(resets).toEqual(["new"]));
    expect(entries()).toEqual([
      ["_rinka_fn", "src/form-test.ts#save"],
      ["body", "new"],
      ["text", "new"],
      ["note", "new"],
      ["choice", "new"],
      ["check", "on"],
    ]);
  });

  it("描き直しでフォームが別のノードに置き換わっても、フォームの値は新しいページの値になる", async () => {
    await submitted((element) => formPage(element, "new", "g"));
    const before = document.querySelector("form");
    document.querySelector("button")!.click();
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBe(before));
    await tick();
    expect(entries()).toEqual([
      ["_rinka_fn", "src/form-test.ts#save"],
      ["body", "new"],
      ["text", "new"],
      ["note", "new"],
      ["choice", "new"],
      ["check", "on"],
    ]);
  });
});

describe("refreshPage", () => {
  it("現在の URL に描き直しのヘッダーを付けて GET を送り、レスポンスを反映する", async () => {
    run(bootstrapSource);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(refreshJson({ head: "<title>refreshed</title>" })));
    await refreshPage();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(location.href);
    expect(new Headers(init?.headers).get("x-rinka-refresh")).toBe("1");
    expect(document.title).toBe("refreshed");
  });

  it("後に呼び出した描き直しを反映した後に届いた、前の呼び出しのレスポンスは反映しない", async () => {
    run(bootstrapSource);
    const firstResponse = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(Response.json(refreshJson({ head: "<title>second</title>" })));
    const first = refreshPage();
    await refreshPage();
    firstResponse.resolve(Response.json(refreshJson({ head: "<title>first</title>" })));
    await first;
    expect(document.title).toBe("second");
  });

  it("前の呼び出しのレスポンスが先に届いたら、前と後のレスポンスを届いた順に反映する", async () => {
    run(bootstrapSource);
    const secondResponse = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(refreshJson({ head: "<title>first</title>" })))
      .mockReturnValueOnce(secondResponse.promise);
    const first = refreshPage();
    const second = refreshPage();
    await first;
    expect(document.title).toBe("first");
    secondResponse.resolve(Response.json(refreshJson({ head: "<title>second</title>" })));
    await second;
    expect(document.title).toBe("second");
  });

  it("rinka のサーバーが描画していないページでは、エラーを投げる", async () => {
    await expect(refreshPage()).rejects.toThrow("refreshPage()");
  });
});
