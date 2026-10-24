import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { listenForms } from "../../src/client/form.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { refreshPage } from "../../src/client/refresh.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import type { RefreshJson } from "../../src/shared/refresh.ts";
import { rpcPath, wireFormat, wireHeader } from "../../src/shared/wire.ts";

/** 最後の submit のイベントが、window に届いた時点でデフォルトの動作を止められていたかどうかである。 */
let prevented: boolean | undefined;
/** window に届いた submit のイベントを記録し、ページの移動を止める。 */
const block = (event: Event) => {
  prevented = event.defaultPrevented;
  event.preventDefault();
};
let titleBefore = "";

beforeEach(() => {
  listenForms();
  prevented = undefined;
  titleBefore = document.title;
  window.addEventListener("submit", block);
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(bootstrapSource)();
});

afterEach(() => {
  window.removeEventListener("submit", block);
  document.body.replaceChildren();
  document.title = titleBefore;
  delete (globalThis as { $rinka?: unknown }).$rinka;
  vi.restoreAllMocks();
});

const action = rpcPath("src/form-test.ts#save");

/** rinka が組み立てた RPC のレスポンスを示すヘッダーである。 */
const rpcHeaders = { [wireHeader]: wireFormat.rpc };

/** サーバー関数を送信先にするフォームを body に配置し、フォームと送信のボタンを返す。 */
function placeForm(html = `<form action="${action}" method="post">`): {
  form: HTMLFormElement;
  button: HTMLButtonElement;
} {
  document.body.innerHTML = `${html}<input name="a" value="1"><button name="b" value="2">go</button></form>`;
  return {
    form: document.querySelector("form")!,
    button: document.querySelector("button")!,
  };
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

/** スロットに配置したフォームを持つ要素を配置し、要素が描画した後に送信のボタンを返す。 */
const placeSlotted = async () => {
  document.body.innerHTML = `<div id="wrap"><test-form-slot><form action="${action}" method="post"><button>go</button></form></test-form-slot></div>`;
  const host = document.querySelector("test-form-slot")!;
  await vi.waitFor(() => expect(host.shadowRoot?.querySelector("slot")).toBeTruthy());
  return document.querySelector("button")!;
};

describe("JS があるときのフォームの送信", () => {
  it("押したボタンの値を含む FormData を、x-rinka-page に現在の URL を付けて送信先に POST し、送信中は aria-busy を付与する", async () => {
    const response = Promise.withResolvers<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const { form, button } = placeForm();
    button.click();
    expect(prevented).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(action, location.href));
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-rinka-page")).toBe(location.href);
    const body = init?.body;
    expect(body instanceof FormData && [...body]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    response.resolve(
      Response.json(refreshJson({ head: "<title>failed</title>" }), { status: 500 }),
    );
    await vi.waitFor(() => expect(form.hasAttribute("aria-busy")).toBe(false));
  });

  it("送信中のフォームの再送信は、送信せずにデフォルトの動作だけを止める", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    const { button } = placeForm();
    button.click();
    button.click();
    expect(prevented).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("送信先の URL で解決した移動先が現在のページなら、フォームを初期値に戻してから、レスポンスの page を反映する", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          redirect: `${location.pathname}${location.search}#top`,
          page: refreshJson({ head: "<title>saved</title>" }),
        },
        { headers: rpcHeaders },
      ),
    );
    const { form, button } = placeForm();
    let titleAtReset = "";
    vi.spyOn(form, "reset").mockImplementation(() => {
      titleAtReset = document.title;
    });
    button.click();
    await vi.waitFor(() => expect(document.title).toBe("saved"));
    expect(titleAtReset).toBe(titleBefore);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rinka が組み立てたことを示すヘッダーの無い { redirect } は、移動せずにコンソールに記録する", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ redirect: "/x" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { button } = placeForm();
    button.click();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("送信の後に始まった描き直しがあれば、送信の結果の描き直しは反映しない", async () => {
    const submitted = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(submitted.promise)
      .mockResolvedValueOnce(Response.json(refreshJson({ head: "<title>refreshed</title>" })));
    const { form, button } = placeForm();
    button.click();
    await refreshPage();
    submitted.resolve(
      Response.json(refreshJson({ head: "<title>error page</title>" }), { status: 500 }),
    );
    await vi.waitFor(() => expect(form.hasAttribute("aria-busy")).toBe(false));
    expect(document.title).toBe("refreshed");
  });

  it("送信がページに反映できない結果で終わっても、前に始まった描き直しは反映する", async () => {
    const refreshed = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { form, button } = placeForm();
    const refreshing = refreshPage();
    button.click();
    await vi.waitFor(() => expect(form.hasAttribute("aria-busy")).toBe(false));
    refreshed.resolve(Response.json(refreshJson({ head: "<title>refreshed</title>" })));
    await refreshing;
    expect(document.title).toBe("refreshed");
  });

  it("送信の結果を受け取ったフォームは、後に始まった送信が終わる前に、送信中の状態を解除する", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(refreshJson({ head: "<title>error page</title>" }), { status: 500 }),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    document.body.innerHTML = `<form id="a" action="${action}" method="post"><button>a</button></form><form id="b" action="${action}" method="post"><button>b</button></form>`;
    const first = document.querySelector<HTMLFormElement>("#a")!;
    first.querySelector("button")!.click();
    document.querySelector<HTMLButtonElement>("#b button")!.click();
    await vi.waitFor(() => expect(first.hasAttribute("aria-busy")).toBe(false));
    expect(document.title).toBe("error page");
  });

  it("起動スクリプトを読み込んでいないページでは、ブラウザの通常の送信のまま扱う", () => {
    delete (globalThis as { $rinka?: unknown }).$rinka;
    const fetch = vi.spyOn(globalThis, "fetch");
    placeForm().button.click();
    expect(prevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("描き直しの JSON のレスポンスは、そのままページに反映する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(refreshJson({ head: "<title>error page</title>" }), { status: 500 }),
    );
    const { button } = placeForm();
    button.click();
    await vi.waitFor(() => expect(document.title).toBe("error page"));
  });

  it("ページ以外のレスポンスは、ページを変更せずにコンソールに記録する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ issues: [] }, { status: 422 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { form, button } = placeForm();
    button.click();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(String(error.mock.calls[0]?.[0])).toContain("ステータス 422 ");
    expect(document.body.contains(form)).toBe(true);
    expect(document.title).toBe(titleBefore);
  });

  it("onSubmit でデフォルトの動作を止めたフォームと、サーバー関数を送信先にしないフォームは、送信しない", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { form, button } = placeForm();
    form.addEventListener("submit", (event) => event.preventDefault());
    button.click();
    placeForm('<form action="/other" method="post">').button.click();
    expect(prevented).toBe(false);
    placeForm(`<form action="${action}">`).button.click();
    expect(prevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("action と method という名前のコントロールがあるフォームも、属性の送信先と method で送信する", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    const { button } = placeForm(
      `<form action="${action}" method="post"><input name="action" value="x"><input name="method" value="get">`,
    );
    button.click();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("要素のスロットに配置したフォームは、ホストより外側の onSubmit の後に、document で 1 回だけ送信する", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    defineElement("test-form-slot", () => jsx("slot", {}), { props: {} });
    (await placeSlotted()).click();
    expect(fetch).toHaveBeenCalledTimes(1);
    const button = await placeSlotted();
    document.querySelector("#wrap")!.addEventListener("submit", (event) => event.preventDefault());
    button.click();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("要素の Shadow DOM の中のフォームも送信する", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    defineElement(
      "test-form-host",
      () =>
        jsx("form", {
          action,
          method: "post",
          children: jsx("button", { name: "b", value: "2", children: "go" }),
        }),
      { props: {} },
    );
    const host = document.createElement("test-form-host");
    document.body.append(host);
    await vi.waitFor(() => expect(host.shadowRoot?.querySelector("button")).toBeTruthy());
    host.shadowRoot!.querySelector("button")!.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.shadowRoot!.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
  });
});
