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
