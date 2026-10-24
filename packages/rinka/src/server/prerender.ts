import type { Output, PrerenderScope, PrerenderTarget } from "../shared/prerender.ts";
import { fillPattern, parseSegment } from "../shared/route-segments.ts";
import { routeMethods, type Route, type Routes } from "../shared/routes.ts";
import { internalPrefix } from "../shared/wire.ts";

/** 書き出す URL の区切りに含められない文字である。`encodeURIComponent` がエンコードし `decodeURI` がデコードしない文字、`%`、Windows のファイル名に使用できない文字である。 */
const UNSAFE = '/\\;,?:@&=+$#<>"|*%'.split("");

/** ページと `route.ts` の行を表す。 */
type Target = Extract<Route, { readonly kind: "page" | "route" }>;

/** ページの行を表す。 */
type Page = Extract<Route, { readonly kind: "page" }>;

/**
 * ルートの表 `routes` のページと `route.ts` の行のうち、`scope` に含まれるものから、書き出す URL を返す。
 * `output` が `static` の `scope` はすべての行を含み、`server` の `scope` は `files` のモジュールの行だけを含む。`static` では、最後に `404.html` の対象を加える。
 * `static` では、`prerender` の無いページはパラメータが無ければ書き出し、`prerender` の無い `route.ts` はパラメータが無ければ書き出す。
 * `prerender` の値が行の形に合わないとき、URL にできないパラメータの値と、重複した URL があるとき、`route.ts` の URL の最後の区切りに拡張子が無いとき、
 * `static` で、パラメータのあるページに `prerender` が無いときと、`route.ts` が `GET` 以外のメソッドを export するときは、エラーを投げる。
 */
export async function prerenderTargets(
  routes: Routes,
  scope: PrerenderScope,
): Promise<PrerenderTarget[]> {
  const rows = routes.routes.flatMap((route) =>
    route.kind !== "not-found" &&
    (scope.output === "static" || scope.files.includes(route.module.file))
      ? [route]
      : [],
  );
  const targets = await Promise.all(
    rows.map(async (route): Promise<PrerenderTarget[]> => {
      const urls = await urlsOf(route, scope.output);
      return urls === undefined ? [] : [{ kind: route.kind, file: route.module.file, urls }];
    }),
  );
  return [
    ...targets.flat(),
    ...(scope.output === "static"
      ? [{ kind: "not-found", urls: [`${internalPrefix}not-found`] } as const]
      : []),
  ];
}

/** 行 `route` の書き出す URL を返す。書き出さない行には `undefined` を返す。`output` が `static` なら、`prerender` の無い行も書き出す。 */
async function urlsOf(route: Target, output: Output): Promise<string[] | undefined> {
  const { pattern } = route;
  const { file } = route.module;
  const params = paramsOf(pattern);
  const module = objectOf(await route.module());
  const prerender: unknown = Reflect.get(module, "prerender");
  if (prerender === undefined && output === "server") return undefined;
  if (route.kind === "page" && params.length > 0) {
    return (await prerenderParams(route))?.map(({ url }) => url);
  }
  if (route.kind === "page") {
    if (prerender !== undefined && prerender !== true) {
      throw new Error(
        `${file}: パラメータの無いページの prerender には、true を指定してください。`,
      );
    }
    return [pattern];
  }
  if (prerender !== undefined && prerender !== true) {
    throw new Error(`${file}: route.ts の prerender には、true を指定してください。`);
  }
  if (params.length > 0) {
    throw new Error(
      `${file}: パラメータのある route.ts は書き出せません。書き出す route.ts は、パラメータの無いディレクトリに置いてください。`,
    );
  }
  if (
    output === "static" &&
    routeMethods.some((method) => method !== "GET" && Reflect.has(module, method))
  ) {
    throw new Error(
      `${file}: GET 以外のメソッドを export する route.ts は、サーバーを置かないアプリでは書き出せません。`,
    );
  }
  if (!/\.[\w-]+$/.test(pattern)) {
    throw new Error(
      `${file}: route.ts を書き出すには、URL の最後の区切りに拡張子（feed.xml の .xml など）を付けてください。`,
    );
  }
  return [pattern];
}

/**
 * パラメータのあるページの行 `route` の `prerender` が返す各パラメータについて、値を文字列にしたパラメータ `values` と、それを埋めた URL `url` を返す。
 * パラメータの無いページには `undefined` を返す。`prerender` が関数でないとき、URL の区切りにできない値と、重複したパラメータがあるときは、エラーを投げる。
 */
export async function prerenderParams(
  route: Page,
): Promise<
  { readonly values: Readonly<Record<string, string>>; readonly url: string }[] | undefined
> {
  const { file } = route.module;
  const params = paramsOf(route.pattern);
  if (params.length === 0) return undefined;
  const prerender: unknown = Reflect.get(objectOf(await route.module()), "prerender");
  if (typeof prerender !== "function") {
    throw new Error(
      `${file}: パラメータのあるページの prerender には、書き出すパラメータの配列を返す関数を指定してください。`,
    );
  }
  const list: unknown = await Reflect.apply(prerender, undefined, []);
  if (!Array.isArray(list)) {
    throw new Error(`${file}: prerender の関数は、パラメータの配列を返してください。`);
  }
  const names = params.map((param) => param.name);
  const entries = list.map((item: unknown, index) => {
    const values = objectOf(item);
    const pairs = params.map(({ kind, name }) => {
      const value: unknown = Reflect.get(values, name);
      const text = typeof value === "number" ? String(value) : value;
      const parts =
        typeof text === "string" ? (kind === "catch-all" ? text.split("/") : [text]) : [];
      if (
        parts.length === 0 ||
        parts.some(
          (part) =>
            part === "" ||
            part === "." ||
            part === ".." ||
            UNSAFE.some((char) => part.includes(char)),
        )
      ) {
        return undefined;
      }
      return [name, String(text)] as const;
    });
    const extra = Object.keys(values).find((name) => !names.includes(name));
    if (pairs.includes(undefined) || extra !== undefined) {
      throw new Error(
        `${file}: prerender の関数が返した ${index + 1} 番目のパラメータは、${names.join("、")} の値を、URL の区切りにできる文字列か数で持ち、ほかの名前を持たないようにしてください。空の文字列、「.」、「..」と、${UNSAFE.join(" ")} のどれかを含む文字列は、区切りにできません。`,
      );
    }
    const record = Object.fromEntries(pairs.filter((pair) => pair !== undefined));
    return { values: record, url: fillPattern(route.pattern, record) };
  });
  const urls = entries.map(({ url }) => url);
  const duplicate = urls.find((url, index) => urls.indexOf(url) !== index);
  if (duplicate !== undefined) {
    throw new Error(`${file}: prerender の関数が、${duplicate} のパラメータを 2 回返しました。`);
  }
  return entries;
}

/** ファイルの形のパス `pattern` の、パラメータとキャッチオールの区切りを返す。 */
const paramsOf = (pattern: string) =>
  pattern.split("/").flatMap((part) => {
    const segment = parseSegment(part);
    return segment?.kind === "param" || segment?.kind === "catch-all" ? [segment] : [];
  });

/** `value` がオブジェクトか関数ならそれを、それ以外なら空のオブジェクトを返す。 */
const objectOf = (value: unknown): object =>
  (typeof value === "object" && value !== null) || typeof value === "function" ? value : {};
