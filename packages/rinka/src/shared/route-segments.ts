/** ディレクトリの名前が表す、ルートの区切りを表す。 */
export type RouteSegment =
  | { readonly kind: "static"; readonly name: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "catch-all"; readonly name: string }
  | { readonly kind: "group" };

/**
 * ディレクトリの名前 `name` を、ルートの区切りとして解釈する。
 * `[id]` は動的な区切り、`[...slug]` はキャッチオール、`(name)` はグループになる。`[` か `(` で始まり、どの形でもない名前には `undefined` を返す。
 */
export function parseSegment(name: string): RouteSegment | undefined {
  if (/^\(.+\)$/.test(name)) return { kind: "group" };
  const catchAll = /^\[\.\.\.(\w+)\]$/.exec(name)?.[1];
  if (catchAll !== undefined) return { kind: "catch-all", name: catchAll };
  const param = /^\[(\w+)\]$/.exec(name)?.[1];
  if (param !== undefined) return { kind: "param", name: param };
  return name.startsWith("[") || name.startsWith("(") ? undefined : { kind: "static", name };
}
