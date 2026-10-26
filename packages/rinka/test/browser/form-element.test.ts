import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { defineElement } from "../../src/client/element.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { defineElement as defineServer } from "../../src/server/element.ts";
import { jsx as serverJsx } from "../../src/server/jsx-runtime.ts";
import { renderToStream } from "../../src/server/response.ts";
import type { Ctx, ElementOptions } from "../../src/shared/element.ts";
import type { Receiver } from "../../src/shared/receiver.ts";
import { memo, signal } from "../../src/shared/signals.ts";
import { toNode } from "./nodes.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let count = 0;
const nextTag = () => `test-form-el-${++count}`;

afterEach(() => {
  document.body.replaceChildren();
});

/** `html` を `document.body` に配置し、要素が起動するまで待つ。 */
async function place(html: string): Promise<void> {
  document.body.innerHTML = html;
  await tick();
  flush();
  await tick();
  flush();
}

/** 値を設定する関数を `setters` に記録する、フォームの部品を登録してタグ名を返す。 */
function defineField(setters: ((value: string) => void)[] = []): string {
  const tag = nextTag();
  defineElement(
    tag,
    (_props: object, { form }: Ctx) => {
      const [value, setValue] = signal("a");
      setters.push(setValue);
      form.value(() => value());
      form.validity(() =>
        value() === "" ? { valueMissing: true, message: "入力してください" } : null,
      );
      form.onReset(() => setValue("a"));
      form.onRestore((state) => setValue(typeof state === "string" ? state : ""));
      return jsx("button", { type: "button", disabled: () => form.disabled() });
    },
    { props: {}, form: true },
  );
  return tag;
}

/** ホストの Shadow DOM の中のボタンを返す。 */
const button = (host: Element) => host.shadowRoot!.querySelector("button")!;

describe("フォームの部品", () => {
  it("form.value の値を、ホストの name で FormData に入れ、値が変わると更新する", async () => {
    const setters: ((value: string) => void)[] = [];
    const tag = defineField(setters);
    await place(`<form><${tag} name="score"></${tag}></form>`);
    const form = document.querySelector("form")!;
    expect(new FormData(form).get("score")).toBe("a");
    setters[0]!("b");
    flush();
    await tick();
    expect(new FormData(form).get("score")).toBe("b");
  });

  it("form.validity が返した制約と文言で無効にし、null で有効にする。制約を指定しなければ customError にする", async () => {
    const setters: ((value: string) => void)[] = [];
    const tag = defineField(setters);
    await place(`<form><${tag} name="score"></${tag}></form>`);
    const host = document.querySelector<HTMLElement & { validity: ValidityState }>(tag)!;
    expect(host.validity.valid).toBe(true);
    setters[0]!("");
    flush();
    await tick();
    expect(host.validity.valueMissing).toBe(true);
    expect((host as unknown as { validationMessage: string }).validationMessage).toBe(
      "入力してください",
    );
    expect(document.querySelector("form")!.checkValidity()).toBe(false);

    const custom = nextTag();
    defineElement(
      custom,
      (_props: object, { form }: Ctx) => {
        form.validity(() => ({ message: "だめです" }));
        return null;
      },
      { props: {}, form: true },
    );
    await place(`<${custom}></${custom}>`);
    const other = document.querySelector<HTMLElement & { validity: ValidityState }>(custom)!;
    expect(other.validity.customError).toBe(true);
  });

  it("<form> のリセットで form.onReset の関数を呼び、復元で form.onRestore の関数に値を渡す", async () => {
    const setters: ((value: string) => void)[] = [];
    const tag = defineField(setters);
    await place(`<form><${tag} name="score"></${tag}></form>`);
    const form = document.querySelector("form")!;
    setters[0]!("b");
    flush();
    form.reset();
    flush();
    await tick();
    expect(new FormData(form).get("score")).toBe("a");
    const host = document.querySelector(tag) as HTMLElement & {
      formStateRestoreCallback: (state: string, mode: string) => void;
    };
    host.formStateRestoreCallback("c", "restore");
    flush();
    await tick();
    expect(new FormData(form).get("score")).toBe("c");
  });

  it("form.disabled() は、ホストの disabled と外側の <fieldset disabled> で true を返し、無効な部品は値を送信しない", async () => {
    const tag = defineField();
    await place(
      `<form><fieldset disabled><${tag} name="a"></${tag}></fieldset><${tag} name="b" disabled></${tag}><${tag} name="c"></${tag}></form>`,
    );
    const [inFieldset, own, enabled] = Array.from(document.querySelectorAll(tag));
    expect(button(inFieldset!).disabled).toBe(true);
    expect(button(own!).disabled).toBe(true);
    expect(button(enabled!).disabled).toBe(false);
    expect(Array.from(new FormData(document.querySelector("form")!).keys())).toEqual(["c"]);
    document.querySelector("fieldset")!.disabled = false;
    flush();
    await tick();
    expect(button(inFieldset!).disabled).toBe(false);
  });

  it("フォームの部品のホストは、ElementInternals の form、labels、validity などを返し、Shadow DOM がフォーカスを中の部品に渡す", async () => {
    const tag = defineField();
    await place(`<form><label for="f">評価</label><${tag} id="f" name="score"></${tag}></form>`);
    const host = document.querySelector(tag) as HTMLElement & {
      form: HTMLFormElement | null;
      labels: NodeList;
      willValidate: boolean;
      checkValidity: () => boolean;
      reportValidity: () => boolean;
    };
    expect(host.form).toBe(document.querySelector("form"));
    expect(Array.from(host.labels)).toEqual([document.querySelector("label")]);
    expect(host.willValidate).toBe(true);
    expect(host.checkValidity()).toBe(true);
    expect(host.reportValidity()).toBe(true);
    expect(host.shadowRoot!.delegatesFocus).toBe(true);
    host.focus();
    expect(host.shadowRoot!.activeElement).toBe(host.shadowRoot!.querySelector("button"));
  });

  it("Props の型に宣言した name と disabled も、ホストの属性に反映する", async () => {
    const tag = nextTag();
    defineElement(
      tag,
      (_props: { name?: string; disabled?: boolean }, { form }: Ctx) => {
        form.value(() => "v");
        return null;
      },
      { props: { name: "string", disabled: "boolean" }, form: true },
    );
    await place("<form></form>");
    const host = document.createElement(tag) as HTMLElement & { name?: string; disabled?: boolean };
    host.name = "score";
    document.querySelector("form")!.append(host);
    await tick();
    flush();
    await tick();
    expect(host.getAttribute("name")).toBe("score");
    expect(new FormData(document.querySelector("form")!).get("score")).toBe("v");
    host.disabled = true;
    flush();
    expect(host.hasAttribute("disabled")).toBe(true);
    expect(host.disabled).toBe(true);
    host.disabled = false;
    flush();
    expect(host.hasAttribute("disabled")).toBe(false);
  });

  it("Props の型で数値にした name も、属性の値にして反映する", async () => {
    const tag = nextTag();
    let seen: { name?: number } = {};
    defineElement(
      tag,
      (props: { name?: number }, { form }: Ctx) => {
        seen = props;
        form.value(() => "v");
        return null;
      },
      { props: { name: "number" }, form: true },
    );
    await place("<form></form>");
    const host = document.createElement(tag) as HTMLElement & { name?: number };
    host.name = 3;
    document.querySelector("form")!.append(host);
    await tick();
    flush();
    await tick();
    expect(host.getAttribute("name")).toBe("3");
    expect(new FormData(document.querySelector("form")!).get("3")).toBe("v");
    expect(seen.name).toBe(3);
  });

  it("親が JSX で渡した、Props の型に宣言した name と disabled の変化を、ホストの属性と props に反映する", async () => {
    const tag = nextTag();
    let seen: { name?: string; disabled?: boolean } = {};
    const Field = defineElement(
      tag,
      (props: { name?: string; disabled?: boolean }, { form }: Ctx) => {
        seen = props;
        form.value(() => "v");
        return null;
      },
      { props: { name: "string", disabled: "boolean" }, form: true },
    );
    const [name, setName] = signal("a");
    const [disabled, setDisabled] = signal(false);
    const host = createRoot(() =>
      toNode<HTMLElement & { name?: string; disabled?: boolean }>(
        jsx(Field, {
          get name() {
            return name();
          },
          get disabled() {
            return disabled();
          },
        }),
      ),
    );
    await place("<form></form>");
    const form = document.querySelector("form")!;
    form.append(host);
    await tick();
    flush();
    await tick();
    expect(host.getAttribute("name")).toBe("a");
    setName("b");
    setDisabled(true);
    flush();
    expect(host.getAttribute("name")).toBe("b");
    expect(host.hasAttribute("disabled")).toBe(true);
    expect(seen.name).toBe("b");
    setName("c");
    setDisabled(false);
    flush();
    expect(host.getAttribute("name")).toBe("c");
    expect(host.hasAttribute("disabled")).toBe(false);
    expect(host.disabled).toBe(false);
    expect(seen.name).toBe("c");
    expect(new FormData(form).get("c")).toBe("v");
  });

  it("フォームの部品でない要素は、internals を受け取り、form.value と form.validity を呼ぶとエラーを投げる", async () => {
    const tag = nextTag();
    const caught: unknown[] = [];
    let received: ElementInternals | undefined;
    defineElement(
      tag,
      (_props: object, { form, internals }: Ctx) => {
        received = internals;
        internals.role = "status";
        for (const call of [() => form.value(() => "a"), () => form.validity(() => null)]) {
          try {
            call();
          } catch (error) {
            caught.push(error);
          }
        }
        return null;
      },
      { props: {} },
    );
    await place(`<${tag}></${tag}>`);
    expect(received).toBeInstanceOf(ElementInternals);
    expect(received?.role).toBe("status");
    expect(caught).toHaveLength(2);
    expect(String(caught[0])).toContain(tag);
    expect(document.querySelector(tag)!.shadowRoot!.delegatesFocus).toBe(false);
  });
});

/** サーバーとクライアントで同じタグの要素を登録する。 */
function defineBoth(tag: string, fn: (props: object, ctx: Ctx) => unknown, form = true) {
  const options: ElementOptions = { props: {}, ...(form && { form: true as const }) };
  return {
    server: defineServer(tag, fn, options),
    client: () => defineElement(tag, fn, options),
  };
}

/** `node` をサーバーで描画し、起動スクリプトを実行して、本文を <form> の中に配置する。 */
async function serve(node: unknown): Promise<HTMLFormElement> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of renderToStream(serverJsx("form", { children: node }))) {
    text += decoder.decode(chunk);
  }
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(bootstrapSource)();
  const body = text.slice(text.indexOf("<body>") + 6, text.indexOf("</body>"));
  const container = document.createElement("div");
  container.setHTMLUnsafe(body.replaceAll(/<script>.*?<\/script>/gs, ""));
  document.body.append(container);
  return document.querySelector("form")!;
}

describe("SSR したフォームの部品の起動", () => {
  afterEach(() => {
    delete (globalThis as { $rinka?: unknown }).$rinka;
  });

  it("起動すると、data-rinka-aria に列挙した属性と data-rinka-aria を削除し、ページの属性は残す", async () => {
    const tag = nextTag();
    const { server, client } = defineBoth(
      tag,
      (_props, { internals }) => {
        internals.role = "slider";
        internals.ariaValueNow = "3";
        return null;
      },
      false,
    );
    await serve(serverJsx(server, { "aria-label": "音量" }));
    const host = document.querySelector(tag)!;
    expect(host.getAttribute("data-rinka-aria")).toBe("role aria-valuenow");
    client();
    await tick();
    flush();
    expect(host.hasAttribute("role")).toBe(false);
    expect(host.hasAttribute("aria-valuenow")).toBe(false);
    expect(host.hasAttribute("data-rinka-aria")).toBe(false);
    expect(host.getAttribute("aria-label")).toBe("音量");
  });

  it("起動して値を設定すると hidden input を削除し、値を 1 回だけ送信する。起動する前は hidden input の値を送信する", async () => {
    const tag = nextTag();
    const { server, client } = defineBoth(tag, (_props, { form }) => {
      form.value(() => "v");
      return null;
    });
    const form = await serve(serverJsx(server, { name: "n" }));
    const host = document.querySelector(tag)!;
    expect(new FormData(form).getAll("n")).toEqual(["v"]);
    client();
    await tick();
    flush();
    await tick();
    expect(host.querySelector("input[data-rinka-form]")).toBeNull();
    expect(new FormData(form).getAll("n")).toEqual(["v"]);
  });

  it("定義した後でも、起動するまでは hidden input を残す", async () => {
    const tag = nextTag();
    const { server, client } = defineBoth(tag, (_props, { form }) => {
      form.value(() => "v");
      return null;
    });
    const form = await serve(
      serverJsx("div", {
        style: "display: none",
        children: serverJsx(server, { name: "n", "load:visible": true }),
      }),
    );
    (globalThis as unknown as { $rinka: Receiver }).$rinka.m([
      [tag, "data:text/javascript,", "visible"],
    ]);
    client();
    await tick();
    flush();
    expect(document.querySelector(`${tag} > input[data-rinka-form]`)).not.toBeNull();
    expect(new FormData(form).getAll("n")).toEqual(["v"]);
  });

  it("引き継いだ描画を表示するまでは、サーバーの ARIA 属性を残す", async () => {
    const tag = nextTag();
    const pending = Promise.withResolvers<string>();
    const server = defineServer(
      tag,
      (_props: object, { internals }: Ctx) => {
        internals.ariaValueText = "x";
        return null;
      },
      { props: {} },
    );
    await serve(serverJsx(server, {}));
    const host = document.querySelector(tag)!;
    defineElement(
      tag,
      (_props: object, { internals }: Ctx) => {
        const value = memo(() => pending.promise);
        createEffect(
          () => value(),
          (text) => {
            internals.ariaValueText = text;
          },
        );
        return jsx("p", { children: () => value() });
      },
      { props: {} },
    );
    await tick();
    flush();
    expect(host.getAttribute("aria-valuetext")).toBe("x");
    pending.resolve("y");
    await tick();
    flush();
    await tick();
    flush();
    expect(host.hasAttribute("aria-valuetext")).toBe(false);
    expect(host.hasAttribute("data-rinka-aria")).toBe(false);
  });
});
