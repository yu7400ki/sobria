import { fillPattern, patternParams } from "../shared/route-segments.ts";
import { routeMethods, type Route, type Routes } from "../shared/routes.ts";

/** 書き出す URL を、ページか `route.ts` の行ごとに表す。`pattern` は行のファイルの形のパスである。 */
export interface PrerenderTarget {
  readonly kind: "page" | "route";
  readonly pattern: string;
  readonly urls: readonly string[];
}

/** ページと `route.ts` の行を表す。 */
type Target = Extract<Route, { readonly kind: "page" | "route" }>;

/**
 * ルートの表 `routes` のページと `route.ts` の行のうち、`scope` に含まれるものから、書き出す URL を返す。
 * `scope` は、行のファイルの形のパスの集合か、すべての行を表す `"all"` である。
 * `"all"` では、`prerender` の無いページはパラメータが無ければ書き出し、`prerender` の無い `route.ts` は `GET` だけを export してパラメータが無ければ書き出す。
 * `prerender` の値が行の形に合わないとき、`route.ts` の URL の最後の区切りに拡張子が無いとき、`"all"` で書き出せない行があるときは、エラーを投げる。
 */
export async function prerenderTargets(
  routes: Routes,
  scope: ReadonlySet<string> | "all",
): Promise<PrerenderTarget[]> {
  const rows = routes.routes.flatMap((route) =>
    route.kind !== "not-found" && (scope === "all" || scope.has(route.pattern)) ? [route] : [],
  );
  const targets = await Promise.all(
    rows.map(async (route) => {
      const urls = await urlsOf(route, scope === "all");
      return urls === undefined ? [] : [{ kind: route.kind, pattern: route.pattern, urls }];
    }),
  );
  return targets.flat();
}

/** 行 `route` の書き出す URL を返す。書き出さない行には `undefined` を返す。`all` は、`prerender` の無い行も書き出すかどうかである。 */
async function urlsOf(route: Target, all: boolean): Promise<string[] | undefined> {
  const { pattern } = route;
  const module = objectOf(await route.module());
  const prerender: unknown = Reflect.get(module, "prerender");
  const params = patternParams(pattern);
  if (route.kind === "route") {
    if (prerender === undefined && !all) return undefined;
    if (prerender !== undefined && prerender !== true) {
      throw new Error(`${pattern} の route.ts の prerender には、true を指定してください。`);
    }
    if (params.length > 0) {
      throw new Error(
        `${pattern} の route.ts はパラメータを持つので、書き出せません。書き出す route.ts は、パラメータの無いディレクトリに置いてください。`,
      );
    }
    const methods = routeMethods.filter((method) => Reflect.get(module, method) !== undefined);
    if (prerender === undefined && methods.some((method) => method !== "GET")) {
      throw new Error(
        `${pattern} の route.ts は GET 以外のメソッドを export するので、output: 'static' では書き出せません。`,
      );
    }
    if (!/\.[\w-]+$/.test(pattern)) {
      throw new Error(
        `${pattern} の route.ts を書き出すには、URL の最後の区切りに拡張子（feed.xml の .xml など）を付けてください。`,
      );
    }
    return [pattern];
  }
  if (prerender === undefined) {
    if (!all) return undefined;
    if (params.length > 0) {
      throw new Error(
        `${pattern} のページはパラメータを持つので、prerender の関数で、書き出すパラメータの一覧を返してください。`,
      );
    }
    return [pattern];
  }
  if (params.length === 0) {
    if (prerender !== true) {
      throw new Error(
        `${pattern} のページはパラメータを持たないので、prerender には true を指定してください。`,
      );
    }
    return [pattern];
  }
  if (typeof prerender !== "function") {
    throw new Error(
      `${pattern} のページはパラメータを持つので、prerender には、パラメータの一覧を返す関数を指定してください。`,
    );
  }
  const list: unknown = await Reflect.apply(prerender, undefined, []);
  if (!Array.isArray(list)) {
    throw new Error(`${pattern} の prerender の関数は、パラメータの配列を返してください。`);
  }
  return list.map((item: unknown, index) => {
    const values = objectOf(item);
    const entries = params.map((name): [string, unknown] => [name, Reflect.get(values, name)]);
    const missing = entries.find(
      ([, value]) => typeof value !== "string" && typeof value !== "number",
    );
    const extra = Object.keys(values).find((name) => !params.includes(name));
    if (missing !== undefined || extra !== undefined) {
      throw new Error(
        `${pattern} の prerender の関数が返した ${index} 番目のパラメータは、${params.join("、")} の値を文字列か数で持ち、ほかの名前を持たないようにしてください。`,
      );
    }
    return fillPattern(
      pattern,
      Object.fromEntries(entries.map(([name, value]) => [name, String(value)])),
    );
  });
}

/** `value` がオブジェクトか関数ならそれを、それ以外なら空のオブジェクトを返す。 */
const objectOf = (value: unknown): object =>
  (typeof value === "object" && value !== null) || typeof value === "function" ? value : {};
