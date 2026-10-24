/** `name=value` の形の文字列の名前と値を表す。 */
interface Pair {
  readonly name: string;
  readonly value: string;
}

/**
 * リクエストの `Cookie` の値 `header` に、レスポンスの `Set-Cookie` の値 `setCookies` を順に反映した `Cookie` の値を返す。
 * `header` に同じ名前が複数あれば、最初の値を使用する。削除を表す `Set-Cookie`（`Max-Age` が 0 以下か、`Max-Age` が無く `Expires` が `now` 以前）の名前は取り除く。
 */
export function cookieAfter(
  header: string | undefined,
  setCookies: readonly string[],
  now = Date.now(),
): string {
  const jar = new Map<string, string>();
  for (const text of (header ?? "").split(";")) {
    const cookie = pairOf(text);
    if (cookie && !jar.has(cookie.name)) jar.set(cookie.name, cookie.value);
  }
  for (const line of setCookies) {
    const [first = "", ...attributes] = line.split(";");
    const cookie = pairOf(first);
    if (!cookie) continue;
    const pairs = attributes.flatMap((text) => pairOf(text) ?? []);
    if (expired(pairs, now)) jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** `name=value` の形の文字列 `text` の名前と値を返す。名前が空なら `undefined` を返す。`=` の無い文字列は、値を空の文字列にする。 */
function pairOf(text: string): Pair | undefined {
  const index = text.indexOf("=");
  const name = (index < 0 ? text : text.slice(0, index)).trim();
  return name === "" ? undefined : { name, value: index < 0 ? "" : text.slice(index + 1).trim() };
}

/** `Set-Cookie` の属性 `attributes` が、Cookie の削除を表すかどうかを返す。 */
function expired(attributes: readonly Pair[], now: number): boolean {
  const valueOf = (name: string) =>
    attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
  const maxAge = valueOf("max-age");
  if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) return Number(maxAge) <= 0;
  const expires = valueOf("expires");
  const time = expires === undefined ? Number.NaN : Date.parse(expires);
  return !Number.isNaN(time) && time <= now;
}
