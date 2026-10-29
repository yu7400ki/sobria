import { PAGE_HEADER } from "../shared/refresh.ts";
import { isRedirectJson, submissionField, wireFormat, wireHeader } from "../shared/wire.ts";
import { applyRefresh, isRefreshJson, redirected, sendRefresh, startRewrite } from "./refresh.ts";

/** 送信中のフォームである。 */
const busy = new WeakSet<HTMLFormElement>();

/**
 * 起動スクリプトを読み込んだページで、リスナーを登録した `document` か `ShadowRoot` の木の中にあるフォームの submit のイベントで、
 * フォームが `action` 属性を持たず、送信ボタンが `formaction` 属性を持たず、`post` で送信し、`_rinka_fn` の hidden input を持つなら、
 * ブラウザの通常の送信を止めて、現在のページの URL に fetch で送信した結果をページに反映する。送信中のフォームのイベントは、デフォルトの動作だけを止める。
 */
export function handleSubmit(event: Event): void {
  if (!globalThis.$rinka || !(event instanceof SubmitEvent) || event.defaultPrevented) return;
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.getRootNode() !== event.currentTarget) return;
  const { submitter } = event;
  const method = (
    submitter?.getAttribute("formmethod") ??
    form.getAttribute("method") ??
    "get"
  ).toLowerCase();
  if (form.hasAttribute("action") || submitter?.hasAttribute("formaction") === true) return;
  const field = form.elements.namedItem(submissionField);
  if (!(field instanceof HTMLInputElement) || field.type !== "hidden") return;
  if (method !== "post") return;
  event.preventDefault();
  if (busy.has(form)) return;
  busy.add(form);
  form.setAttribute("aria-busy", "true");
  submit(form, new URL(location.href), submitter)
    .catch((error: unknown) => {
      console.error(
        "[rinka] フォームを送信できなかったか、送信した結果をページに反映できませんでした。",
        error,
      );
    })
    .finally(() => {
      busy.delete(form);
      form.removeAttribute("aria-busy");
    });
}

/**
 * `form` を `action` に送信し、結果をページに反映する。移動先が現在のページなら、レスポンスの `page` を反映してから、フォームを初期値に戻す。
 * `page` が描き直しの JSON でなければ、ページを読み込み直す。レスポンスが届く前に、後に始まった描き直しを反映していたら、描き直しの JSON を反映せず、フォームも初期値に戻さない。
 */
async function submit(
  form: HTMLFormElement,
  action: URL,
  submitter: HTMLElement | null,
): Promise<void> {
  const reflect = startRewrite();
  const received = await sendRefresh(
    action,
    { [PAGE_HEADER]: location.href },
    { method: "POST", body: new FormData(form, submitter) },
  );
  if (received.kind === "redirect") {
    console.error(
      "[rinka] サーバー関数にフォームを送信して、リダイレクトのレスポンスを受け取りました。ページに反映できないので無視します。",
    );
    return;
  }
  const { response, body } = received;
  if (response.headers.get(wireHeader) === wireFormat.rpc && isRedirectJson(body)) {
    redirected(body, "page" in body ? body.page : undefined, action, reflect, () => form.reset());
  } else if (isRefreshJson(body)) {
    reflect(() => applyRefresh(body));
  } else {
    console.error(
      `[rinka] サーバー関数にフォームを送信して、ステータス ${response.status} のレスポンスを受け取りました。ページに反映できないので無視します。`,
      body,
    );
  }
}

/** `document` の木の中のフォームの submit のイベントを、`handleSubmit` で受け取る。 */
export function listenForms(): void {
  document.addEventListener("submit", handleSubmit);
}
