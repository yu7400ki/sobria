import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { listenForms } from "../../src/client/form.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import type { RefreshJson } from "../../src/shared/refresh.ts";
import { rpcPath } from "../../src/shared/wire.ts";

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

describe("JS があるときのフォームの送信", () => {
  it("押したボタンの値を含む FormData を、x-rinka-refresh: 1 を付けて送信先に POST し、送信中は aria-busy を付与する", async () => {
    const response = Promise.withResolvers<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const { form, button } = placeForm();
    button.click();
    expect(prevented).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL(action, location.href));
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-rinka-refresh")).toBe("1");
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

  it("移動先が現在のページなら、フォームを初期値に戻してから、ページを描き直して反映する", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ redirect: `${location.href.split("#")[0]}#top` }))
      .mockResolvedValueOnce(Response.json(refreshJson({ head: "<title>saved</title>" })));
    const { form, button } = placeForm();
    const reset = vi.spyOn(form, "reset");
    button.click();
    await vi.waitFor(() => expect(document.title).toBe("saved"));
    expect(reset).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(url).toBe(location.href);
    expect(new Headers(init?.headers).get("x-rinka-refresh")).toBe("1");
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
    expect(String(error.mock.calls[0]?.[0])).toContain("422");
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
      { props: [] },
    );
    const host = document.createElement("test-form-host");
    document.body.append(host);
    await vi.waitFor(() => expect(host.shadowRoot?.querySelector("button")).toBeTruthy());
    host.shadowRoot!.querySelector("button")!.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.shadowRoot!.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
  });
});
