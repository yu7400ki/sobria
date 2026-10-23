import { expect, inject, it, vi } from "vitest";

/** `predicate` が真になるまで 10 ms ごとに確認し、2 秒で真にならなければ失敗する。 */
const until = (predicate: () => boolean) =>
  vi.waitUntil(predicate, { timeout: 2000, interval: 10 });

it("開発サーバーで描画したページの要素が、サーバーの memo の値を引き継いで起動し、操作に応答する", async () => {
  const origin = inject("basicOrigin");
  const served = inject("basicPage");
  // クライアントで計算し直すと 4 になる memo の値を、サーバーから送る値だけ 5 にする
  const page = served.replace(/(counter\.tsx:\d+:\d+#0":)4/, "$15");
  expect(page).not.toBe(served);
  const frame = document.createElement("iframe");
  frame.srcdoc = page.replace("<head>", `<head><base href="${origin}/">`);
  document.body.append(frame);

  const shadow = () => frame.contentDocument?.querySelector("app-counter")?.shadowRoot;
  await until(() => shadow()?.querySelector("p")?.textContent === "5");
  const root = shadow()!;
  expect(root.querySelector("button")!.textContent).toBe("clicks: 2");
  const slot = root.querySelector("slot")!;
  expect(slot.assignedNodes().map((node) => node.textContent)).toEqual(["body"]);

  root.querySelector("button")!.click();
  await until(() => root.querySelector("button")!.textContent === "clicks: 3");
});

it("要素の中で作成した子要素は、親が起動して Shadow DOM を作り直した後も、サーバーの memo の値を引き継ぐ", async () => {
  const origin = inject("basicOrigin");
  const served = inject("nestedPage");
  // クライアントで計算し直すと 6 になる子要素の memo の値を、サーバーから送る値だけ 7 にする
  const page = served.replace(/(inner\.tsx:\d+:\d+#0":)6/, "$17");
  expect(page).not.toBe(served);
  const frame = document.createElement("iframe");
  frame.srcdoc = page.replace("<head>", `<head><base href="${origin}/">`);
  document.body.append(frame);

  const outer = () => frame.contentDocument?.querySelector("app-outer");
  await until(() => outer()?.hasAttribute("data-started") === true);
  const inner = outer()!.shadowRoot!.querySelector("app-inner")!;
  expect(inner.shadowRoot!.querySelector("p")!.textContent).toBe("7");
});
