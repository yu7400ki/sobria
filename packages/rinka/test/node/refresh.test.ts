import { describe, expect, it, vi } from "vitest";

import { Errored, Loading, Navigation } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { notFound, redirect } from "../../src/server/errors.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderRefresh } from "../../src/server/render.ts";

/** 描き直しのレスポンスの JSON を表す。 */
interface RefreshJson {
  readonly head: string;
  readonly body: string;
  readonly data: Record<string, string>;
  readonly elements: readonly (readonly [string, string, string])[];
  readonly doc: {
    readonly html: Record<string, string | null>;
    readonly body: Record<string, string | null>;
  };
}

/** `node` を描き直しとして描画し、ステータスと JSON を返す。 */
async function refreshOf(node: unknown, options = {}) {
  const response = await renderRefresh(node, options);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    json: (await response.json()) as RefreshJson,
  };
}

/** `data` の値を評価する。 */
// oxlint-disable-next-line typescript/no-implied-eval
const evaluate = (expression: string): unknown => new Function(`return (${expression})`)();

const executed = vi.fn();

const Card = defineElement(
  "x-refresh-card",
  (props: { label?: string; data?: object; onPick?: () => void; header?: unknown }) => {
    executed();
    return jsx("p", { children: () => props.label });
  },
  {
    props: ["label", "data", "onPick", "header", "children"],
    slots: ["header"],
    functionProps: ["onPick"],
  },
);

const later = (ms: number, node: unknown) => async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return node;
};

/** 描き直しで出力した、最初のホストの ID を返す。 */
const firstHostId = async (): Promise<string> =>
  Object.keys((await refreshOf(jsx(Card, { label: "a" }))).json.data)[0] ?? "";

const missing = () => {
  throw notFound();
};

const broken = () => {
  throw new Error("boom");
};

const moved = () => {
  throw redirect("/login");
};

describe("renderRefresh", () => {
  it("<head> のタグ、本文、<html> と <body> の属性を JSON で返し、<Loading> の内側も待つ", async () => {
    const { status, type, json } = await refreshOf(
      jsx("html", {
        lang: "ja",
        children: jsx("body", {
          class: "app",
          children: [
            jsx("title", { children: "Page" }),
            jsx("meta", { charset: "utf-8" }),
            jsx(Navigation, { transitions: true }),
            jsx("main", {
              children: jsx(Loading, { fallback: "wait", children: jsx(later(5, "done"), {}) }),
            }),
          ],
        }),
      }),
    );
    expect(status).toBe(200);
    expect(type).toContain("application/json");
    expect(json.head).toBe("<title>Page</title><style>@view-transition{navigation:auto}</style>");
    expect(json.body).toBe("<main>done</main>");
    expect(json.doc).toEqual({ html: { lang: "ja" }, body: { class: "app" } });
    expect(json.data).toEqual({});
    expect(json.elements).toEqual([]);
  });

  it("要素を実行せず、Shadow DOM の中身を持たないホストと Light DOM の子を出力し、props を data に入れる", async () => {
    executed.mockClear();
    const { json } = await refreshOf(
      jsx(Card, {
        label: "hi",
        data: { a: 1 },
        header: jsx("b", { children: "head" }),
        children: "child",
      }),
    );
    expect(executed).not.toHaveBeenCalled();
    const match = /^<x-refresh-card data-oh="([^"]+)" label="hi">(.*)<\/x-refresh-card>$/.exec(
      json.body,
    );
    expect(match?.[2]).toBe('<b slot="header">head</b>child');
    const id = match?.[1] ?? "";
    expect(id).toMatch(/^r[0-9a-f]{8}-h\d+$/);
    expect(Object.keys(json.data)).toEqual([id]);
    expect(evaluate(json.data[id] ?? "")).toEqual({
      "@r": { label: "hi", data: { a: 1 } },
      "@p": { data: { a: 1 } },
    });
  });

  it("描画ごとに、ホストの ID の接頭辞を変える", async () => {
    expect((await firstHostId()).split("-")[0]).not.toBe((await firstHostId()).split("-")[0]);
  });

  it("notFound() は not-found のページを 404 で、エラーは error のページを 500 で、どちらも JSON で返す", async () => {
    const options = {
      notFound: () => jsx("p", { children: "missing" }),
      error: () => jsx("p", { children: "broken" }),
    };
    const lost = await refreshOf(jsx(missing, {}), options);
    expect([lost.status, lost.json.body]).toEqual([404, "<p>missing</p>"]);
    const failed = await refreshOf(jsx(broken, {}), options);
    expect([failed.status, failed.json.body]).toEqual([500, "<p>broken</p>"]);
  });

  it("シェルで投げた redirect() は、リダイレクトのレスポンスにする", async () => {
    const response = await renderRefresh(jsx(moved, {}));
    expect([response.status, response.headers.get("location")]).toEqual([303, "/login"]);
  });

  it("<Errored> が受け止めたときは、そのステータスで返す", async () => {
    const { status, json } = await refreshOf(
      jsx(Errored, { fallback: "failed", status: 503, children: jsx(broken, {}) }),
    );
    expect([status, json.body]).toEqual([503, "failed"]);
  });
});
