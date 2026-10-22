import { expect, inject, it, vi } from "vitest";

/** `predicate` が真になるまで 10 ms ごとに確認し、2 秒で真にならなければ失敗する。 */
const until = (predicate: () => boolean) =>
  vi.waitUntil(predicate, { timeout: 2000, interval: 10 });

it("load:visible、load:idle、load:media の要素は、条件を満たした時点でモジュールを読み込んで起動する", async () => {
  const origin = inject("basicOrigin");
  const frame = document.createElement("iframe");
  frame.style.cssText = "width: 300px; height: 150px;";
  frame.srcdoc = inject("loadPage").replace("<head>", `<head><base href="${origin}/">`);
  document.body.append(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  const view = frame.contentWindow!;
  const defined = (tag: string) => view.customElements.get(tag) !== undefined;
  const started = (tag: string) =>
    view.document.querySelector(tag)?.hasAttribute("data-started") === true;

  await until(() => started("app-later"));

  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(defined("app-far")).toBe(false);
  expect(defined("app-wide")).toBe(false);

  view.document.querySelector("app-far")!.scrollIntoView();
  await until(() => started("app-far"));
  expect(defined("app-wide")).toBe(false);

  frame.style.width = "800px";
  await until(() => started("app-wide"));
});
