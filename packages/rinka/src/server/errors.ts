/** リダイレクトのステータスを表す。 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/** `redirect()` が返す値を表す。 */
export class Redirect extends Error {
  constructor(
    readonly location: string,
    readonly status: RedirectStatus,
  ) {
    super(`${location} にリダイレクトします。`);
    this.name = "Redirect";
  }
}

/** `notFound()` が返す値を表す。 */
export class NotFound extends Error {
  constructor() {
    super("ページが見つかりません。");
    this.name = "NotFound";
  }
}

/** URL のスキームに一致する正規表現である。 */
const scheme = /^([a-z][a-z\d+.-]*):/i;

/** ブラウザが URL を解析するときと同じく、タブと改行を除き、先頭の制御文字と空白を除いた文字列を返す。 */
function normalizeUrl(url: string): string {
  const text = url.replaceAll(/[\t\n\r]/g, "");
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  return text.slice(start);
}

/**
 * `location` に移動させる値を返す。返した値をシェルの中で投げると、`status` のリダイレクトのレスポンスになる。
 * `location` には、相対 URL か、http か https の URL を指定する。それ以外のスキームを指定すると、エラーを投げる。
 */
export function redirect(location: string, status: RedirectStatus = 303): Redirect {
  const protocol = scheme.exec(normalizeUrl(location))?.[1]?.toLowerCase();
  if (protocol !== undefined && protocol !== "http" && protocol !== "https") {
    throw new Error(
      `redirect() の移動先 ${JSON.stringify(location)} には、相対 URL か、http か https の URL を指定してください。`,
    );
  }
  return new Redirect(location, status);
}

/** ページが見つからないことを表す値を返す。返した値をシェルの中で投げると、404 のレスポンスになる。 */
export const notFound = (): NotFound => new NotFound();
