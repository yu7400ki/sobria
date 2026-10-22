import { describe, expect, it } from "vitest";

import { isBot } from "../../src/server/bots.ts";
import { Loading } from "../../src/server/control.ts";
import { defineElement } from "../../src/server/element.ts";
import { jsx } from "../../src/server/jsx-runtime.ts";
import { renderToResponse, renderToStream } from "../../src/server/render.ts";
import { memo } from "../../src/shared/signals.ts";

/** ストリームのチャンクを、受け取った順に文字列の配列にする。 */
async function read(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  return chunks;
}

/** 外から解決できる async のコンポーネントを作成する。 */
function deferred(content: unknown) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const Slow = async () => {
    await promise;
    return content;
  };
  return { Slow, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("シェルと後送り", () => {
  it("保留中の Loading は、フォールバックを目印で囲んで送り、中身を後から送る", async () => {
    const { Slow, resolve } = deferred(jsx("b", { children: "done" }));
    const stream = renderToStream(
      jsx("main", { children: jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) }) }),
    );
    const reading = read(stream);
    await tick();
    resolve();
    const chunks = await reading;
    const html = chunks.join("");
    expect(chunks[0]).toContain('<main><template data-ob="b1"></template>wait<!--/ob:b1--></main>');
    expect(chunks[0]).toContain("window.$rinka");
    expect(html).toContain(
      '<template data-os="b1"><b>done</b></template><script>$rinka.r({"b":"b1","bp":[],"p":[],"h":[]})</script>',
    );
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("保留中でない Loading は、フォールバックを出力せずに中身を埋め込み、起動スクリプトを出力しない", async () => {
    const html = (
      await read(
        renderToStream(jsx(Loading, { fallback: "wait", children: jsx("b", { children: "now" }) })),
      )
    ).join("");
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><b>now</b></body></html>',
    );
  });

  it("入れ子の境界は、親の境界を送った後に送る", async () => {
    const inner = deferred("in");
    const outer = deferred(jsx(Loading, { fallback: "i", children: jsx(inner.Slow, {}) }));
    const reading = read(
      renderToStream(jsx(Loading, { fallback: "o", children: jsx(outer.Slow, {}) })),
    );
    await tick();
    inner.resolve();
    await tick();
    outer.resolve();
    const html = (await reading).join("");
    const outerAt = html.indexOf('<template data-os="b1">');
    const innerAt = html.indexOf('<template data-os="b2">');
    expect(outerAt).toBeGreaterThan(0);
    expect(innerAt).toBeGreaterThan(outerAt);
  });

  it("blocking では、すべての境界を待って、フォールバックと差し替えを含まない HTML を送る", async () => {
    const { Slow, resolve } = deferred("done");
    const reading = read(
      renderToStream(jsx(Loading, { fallback: "wait", children: jsx(Slow, {}) }), {
        blocking: true,
      }),
    );
    await tick();
    resolve();
    const html = (await reading).join("");
    expect(html).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>done</body></html>',
    );
  });
});

describe("要素の中の境界", () => {
  it("要素の中の境界は、ホストの ID の列で差し替える先を示し、ホストは data-om で境界の完了を待つ", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const Card = defineElement(
      "x-card",
      () => {
        const value = memo(() => promise);
        return jsx(Loading, { fallback: "wait", children: jsx("b", { children: () => value() }) });
      },
      { props: [] },
    );
    const reading = read(renderToStream(jsx(Card, {})));
    await tick();
    resolve("v");
    const html = (await reading).join("");
    expect(html).toContain(
      '<x-card data-oh="h1" data-om="@b2"><template shadowrootmode="open"><template data-ob="b2"></template>wait<!--/ob:b2--></template></x-card>',
    );
    expect(html).toContain(
      '<template data-os="b2"><b>v</b></template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[],"h":["h1"]})</script>',
    );
  });

  it("スロットに置いた子要素の保留中の状態は、<slot> を囲む境界の差し替えに加わる", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const Container = defineElement(
      "x-container",
      () => jsx(Loading, { fallback: "wait", children: jsx("slot", {}) }),
      { props: ["children"] },
    );
    const Child = defineElement(
      "x-child",
      () => {
        const value = memo(() => promise);
        return jsx("i", { children: () => value() });
      },
      { props: [] },
    );
    const reading = read(renderToStream(jsx(Container, { children: jsx(Child, {}) })));
    await tick();
    resolve("v");
    const html = (await reading).join("");
    expect(html).toContain('<x-container data-oh="h1" data-om="@b2">');
    expect(html).toContain(
      '<x-child data-oh="h3" data-om="@b2"><template shadowrootmode="open"><i><template data-ob="p4"></template><!--/ob:p4--></i></template></x-child>',
    );
    expect(html).toContain(
      '<template data-os="b2"><slot></slot></template><template data-op="p4">v</template><script>$rinka.r({"b":"b2","bp":["h1"],"p":[["p4",["h3"]]],"h":["h1","h3"]})</script>',
    );
  });
});

describe("Response", () => {
  it("renderToResponse は、シェルが揃った時点で HTML の Response を返す", async () => {
    const response = await renderToResponse(jsx("p", { children: "hi" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><p>hi</p></body></html>',
    );
  });
});

describe("isBot", () => {
  it("検索エンジンのクローラーとリンクのプレビューのサービスを bot と判定する", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(
      true,
    );
    expect(isBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(isBot("Twitterbot/1.0")).toBe(true);
    expect(
      isBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isBot(undefined)).toBe(false);
  });
});
