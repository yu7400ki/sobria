/** `redirect()` が返す値を表す。 */
export class Redirect extends Error {
  constructor(
    readonly location: string,
    readonly status: number,
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

/** 投げると、`location` に移動させる値を返す。シェルの中で投げると、`status` のリダイレクトのレスポンスになる。 */
export const redirect = (location: string, status = 303): Redirect =>
  new Redirect(location, status);

/** 投げると、ページが見つからないことを表す値を返す。シェルの中で投げると、404 のレスポンスになる。 */
export const notFound = (): NotFound => new NotFound();
