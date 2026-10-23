import { REFRESH_HEADER } from "../shared/refresh.ts";
import { rpcPrefix } from "../shared/wire.ts";
import { applyRefresh, isRefreshJson, jsonOf, refreshPage } from "./refresh.ts";

/** 送信中のフォームである。 */
const busy = new WeakSet<HTMLFormElement>();

/** `value` が、フォームの送信のリダイレクトを表す JSON かどうかを返す。 */
const isRedirectJson = (value: unknown): value is { readonly redirect: string } =>
  typeof value === "object" &&
  value !== null &&
  "redirect" in value &&
  typeof value.redirect === "string";

/** hash を除いた `url` の文字列を返す。 */
const withoutHash = (url: URL): string => {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href;
};

/**
 * リスナーを登録した `document` か `ShadowRoot` の木の中にあり、サーバー関数を送信先にして `post` で送信するフォームの submit のイベントで、
 * ブラウザの通常の送信を止めて、fetch で送信した結果をページに反映する。送信中のフォームのイベントは、デフォルトの動作だけを止める。
 */
export function handleSubmit(event: Event): void {
  if (!(event instanceof SubmitEvent) || event.defaultPrevented) return;
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.getRootNode() !== event.currentTarget) return;
  const { submitter } = event;
  const action = new URL(
    submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? "",
    location.href,
  );
  const method = (
    submitter?.getAttribute("formmethod") ??
    form.getAttribute("method") ??
    "get"
  ).toLowerCase();
  if (action.origin !== location.origin || !action.pathname.startsWith(rpcPrefix)) return;
  if (method !== "post") return;
  event.preventDefault();
  if (busy.has(form)) return;
  void submit(form, action, submitter);
}

/** `form` を `action` に送信し、結果をページに反映する。 */
async function submit(
  form: HTMLFormElement,
  action: URL,
  submitter: HTMLElement | null,
): Promise<void> {
  busy.add(form);
  form.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(action, {
      method: "POST",
      body: new FormData(form, submitter),
      headers: { [REFRESH_HEADER]: "1" },
      redirect: "manual",
    });
    const body = response.type === "opaqueredirect" ? undefined : await jsonOf(response);
    if (isRedirectJson(body)) {
      const target = new URL(body.redirect, location.href);
      if (withoutHash(target) === withoutHash(new URL(location.href))) {
        form.reset();
        await refreshPage();
      } else {
        location.assign(target.href);
      }
    } else if (isRefreshJson(body)) {
      applyRefresh(body);
    } else {
      const kind =
        response.type === "opaqueredirect" ? "リダイレクト" : `ステータスが ${response.status}`;
      console.error(
        `[rinka] 送信した結果の、${kind}のレスポンスは、ページに反映できないので無視しました。`,
        body,
      );
    }
  } catch (error) {
    console.error("[rinka] フォームを送信した結果を、ページに反映できませんでした。", error);
  } finally {
    busy.delete(form);
    form.removeAttribute("aria-busy");
  }
}

/** `document` の木の中のフォームの submit のイベントを、`handleSubmit` で受け取る。 */
export function listenForms(): void {
  document.addEventListener("submit", handleSubmit);
}
