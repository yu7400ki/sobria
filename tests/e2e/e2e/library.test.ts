import { expect, inject, it, vi } from "vitest";

/** `predicate` が真になるまで 10 ms ごとに確認し、2 秒で真にならなければ失敗する。 */
const until = (predicate: () => boolean) =>
  vi.waitUntil(predicate, { timeout: 2000, interval: 10 });

/** `library: true` でビルドした要素 `tag` のモジュールを読み込む。 */
const load = (tag: string) => import(/* @vite-ignore */ `/@fs/${inject("libraryDir")}/${tag}.js`);

it("ビルドした ES モジュールを読み込むと、フォームの部品が <label for> とフォームの送信で動作し、スロットと共有スタイルが動作する", async () => {
  await Promise.all([load("acme-rating"), load("acme-badge")]);
  document.body.innerHTML = `<form>
  <label for="score">評価</label>
  <acme-rating id="score" name="score" required></acme-rating>
  <acme-badge label="new"><b>slotted</b></acme-badge>
</form>`;
  const form = document.querySelector("form")!;
  const rating = document.querySelector("acme-rating")!;
  expect(document.querySelector("label")!.control).toBe(rating);
  await until(() => rating.shadowRoot?.querySelectorAll("button").length === 5);
  expect(form.checkValidity()).toBe(false);
  rating.shadowRoot!.querySelectorAll("button")[2]!.click();
  await until(() => new FormData(form).get("score") === "3");
  expect(form.checkValidity()).toBe(true);

  const badge = document.querySelector("acme-badge")!;
  await until(() => badge.hasAttribute("data-started"));
  const root = badge.shadowRoot!;
  expect(getComputedStyle(root.querySelector(".badge")!).color).toBe("rgb(0, 128, 0)");
  expect(
    root
      .querySelector("slot")!
      .assignedNodes()
      .map((node) => node.textContent),
  ).toEqual(["slotted"]);
});
