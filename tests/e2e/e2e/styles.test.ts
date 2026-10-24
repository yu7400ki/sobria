import { expect, inject, it, vi } from "vitest";

/** `fixtures/styles` の `/` のページを iframe に表示し、その window を返す。 */
async function open(): Promise<Window> {
  const frame = document.createElement("iframe");
  frame.srcdoc = inject("stylesPage").replace(
    "<head>",
    `<head><base href="${inject("stylesOrigin")}/">`,
  );
  document.body.append(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  return frame.contentWindow!;
}

it("with { type: 'css' } で import したシートの規則を、起動の前と後の要素の Shadow DOM に適用する", async () => {
  const view = await open();
  const card = view.document.querySelector("app-card")!;
  const color = () => view.getComputedStyle(card.shadowRoot!.querySelector(".card")!).color;
  expect(color()).toBe("rgb(255, 0, 0)");
  await vi.waitUntil(() => card.hasAttribute("data-started"), { timeout: 2000, interval: 10 });
  expect(card.shadowRoot!.querySelector("link")).toBeNull();
  expect(card.shadowRoot!.adoptedStyleSheets).toHaveLength(1);
  expect(color()).toBe("rgb(255, 0, 0)");
});

it("Tailwind v4 のユーティリティを、ページと、起動の前と後の要素の Shadow DOM に適用する", async () => {
  const view = await open();
  expect(view.getComputedStyle(view.document.querySelector("main")!).marginTop).toBe("16px");
  const badge = view.document.querySelector("app-badge")!;
  const span = () => view.getComputedStyle(badge.shadowRoot!.querySelector("span")!);
  const look = () => [span().paddingTop, span().rotate, span().boxShadow];
  const before = look();
  expect(before[0]).toBe("8px");
  expect(before[1]).not.toBe("none");
  expect(before[2]).not.toBe("none");
  await vi.waitUntil(() => badge.hasAttribute("data-started"), { timeout: 2000, interval: 10 });
  expect(look()).toEqual(before);
});
