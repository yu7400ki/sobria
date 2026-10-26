/** 起動スクリプトの後に出力した、`$rinka` の受け口を呼ぶスクリプトの呼び出しを表す。 */
type Call =
  | { readonly kind: "r"; readonly at: number; readonly spec: Spec }
  | {
      readonly kind: "d";
      readonly at: number;
      readonly host: string;
      readonly values: Record<string, unknown>;
    }
  | {
      readonly kind: "p";
      readonly at: number;
      readonly host: string;
      readonly key: string;
      readonly state: number;
    };

/** `$rinka.r` の引数を表す。 */
interface Spec {
  readonly b: string;
  readonly bp: readonly string[];
  readonly p: readonly (readonly [string, readonly string[]])[];
}

/** `html` の中の、`$rinka.` で始まるスクリプトを実行し、受け口の呼び出しを出力した順に返す。 */
function calls(html: string): Call[] {
  const found: Call[] = [];
  for (const match of html.matchAll(/<script>(\$rinka\..*?)<\/script>/gs)) {
    const at = match.index;
    const receiver = {
      n: {},
      // 要素の一覧とサーバー関数の受け口は、受け口の順序の検査に関係しないので、呼び出しを記録しない関数にする
      m: () => {},
      f: (id: string, method: string) => ({ serverFn: [id, method] }),
      r: (spec: Spec) => found.push({ kind: "r", at, spec }),
      d: (host: string, values: Record<string, unknown>) =>
        found.push({ kind: "d", at, host, values }),
      s: (value: unknown) => ({ stream: value }),
      p: (host: string, key: string, state: number) =>
        found.push({ kind: "p", at, host, key, state }),
    };
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function("$rinka", match[1] ?? "")(receiver);
  }
  return found;
}

/** `html` の中のホストの開始タグごとに、ホストの ID をキーにして、タグの位置と `data-om` のキーを返す。 */
function hostTags(html: string): Map<string, { at: number; keys: string[] }> {
  const tags = new Map<string, { at: number; keys: string[] }>();
  for (const tag of html.matchAll(/<[a-z][^\s>]*((?:\s+[^\s=>]+(?:="[^"]*")?)*)/g)) {
    const attributes = tag[1] ?? "";
    const id = / data-oh="([^"]*)"/.exec(attributes)?.[1];
    if (id === undefined || tags.has(id)) continue;
    const om = / data-om="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const keys = om
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .split(" ")
      .filter(Boolean);
    tags.set(id, { at: tag.index, keys });
  }
  return tags;
}

/** `data-om` に無いキー `key` の値を送る `$rinka.d` について、キーが `@c:` で始まり、値がページに出力したホストの ID であり、送る先のホストの `@b` より前にあることを確認する。 */
function checkLateChild(
  call: Extract<Call, { kind: "d" }>,
  key: string,
  found: readonly Call[],
  tags: ReadonlyMap<string, unknown>,
): void {
  const child = call.values[key];
  if (!key.startsWith("@c:") || typeof child !== "string" || !tags.has(child)) {
    throw new Error(`$rinka.d のキー ${key} が、ホスト ${call.host} の data-om にありません。`);
  }
  const boundaries = found.find(
    (other) => other.kind === "d" && other.host === call.host && Object.hasOwn(other.values, "@b"),
  );
  if (!boundaries || boundaries.at < call.at) {
    throw new Error(
      `data-om に無いキー ${key} を、ホスト ${call.host} の @b より前に送っていません。`,
    );
  }
}

/**
 * ストリームのチャンクの列が、出力の順序の前提に合うことを確認する。合わなければ、合わない条件と位置を含むエラーを投げる。
 * 前提は、最初のチャンクが文書の先頭であること、`$rinka.r` が境界の目印より後にあること、`$rinka.d` がホストの開始タグより後にあること、
 * `data-om` のキーが重複しないこと、どのキーの値も 1 回だけ送ること、出力したホストの `data-om` の各キーの値を送ること、
 * `@b` が、そのホストを含むすべての `$rinka.r` より後にあることである。
 * 送るキーは、そのホストの `data-om` に列挙したキーか、開始タグの後に作成した子要素の `@c:キー` である。
 * `@c:キー` は、値がページに出力したホストの ID であり、送る先のホストの `@b` より前に送るときだけ受け入れる。
 * `$rinka.p` は、同じホストとキーのストリームを `$rinka.d` で送った後にあり、終わりか失敗を伝えた後には無いことを前提にする。
 */
export function checkOrder(chunks: readonly string[]): void {
  if (!chunks[0]?.startsWith("<!doctype html>")) {
    throw new Error(`最初のチャンクが文書の先頭ではありません: ${chunks[0]?.slice(0, 80)}`);
  }
  const html = chunks.join("");
  const found = calls(html);
  const tags = hostTags(html);
  const sent = new Set<string>();
  const streams = new Map<string, number>();
  for (const call of found) {
    if (call.kind === "p") {
      const id = `${call.host} ${call.key}`;
      const state = streams.get(id);
      if (state !== 0) {
        throw new Error(
          `$rinka.p（${call.at}）の前に、ホスト ${call.host} のキー ${call.key} の届く途中のストリームがありません。`,
        );
      }
      streams.set(id, call.state);
      continue;
    }
    if (call.kind === "r") {
      const marker = html.indexOf(`<template data-ob="${call.spec.b}">`);
      if (marker === -1 || marker > call.at) {
        throw new Error(
          `$rinka.r の境界 ${call.spec.b} の目印が、スクリプト（${call.at}）より前にありません。`,
        );
      }
      continue;
    }
    const tag = tags.get(call.host);
    if (!tag || tag.at > call.at) {
      throw new Error(
        `$rinka.d のホスト ${call.host} の開始タグが、スクリプト（${call.at}）より前にありません。`,
      );
    }
    for (const key of Object.keys(call.values)) {
      if (sent.has(`${call.host} ${key}`)) {
        throw new Error(`ホスト ${call.host} のキー ${key} の値を、2 回以上送りました。`);
      }
      sent.add(`${call.host} ${key}`);
      const value = call.values[key];
      if (typeof value === "object" && value !== null && "stream" in value) {
        streams.set(`${call.host} ${key}`, 0);
      }
      if (!tag.keys.includes(key)) checkLateChild(call, key, found, tags);
      if (key !== "@b") continue;
      const later = found.find(
        (other) =>
          other.kind === "r" &&
          other.at > call.at &&
          (other.spec.bp.includes(call.host) ||
            other.spec.p.some(([, path]) => path.includes(call.host))),
      );
      if (later) {
        throw new Error(
          `ホスト ${call.host} の @b（${call.at}）が、そのホストを含む $rinka.r（${later.at}）より前にあります。`,
        );
      }
    }
  }
  for (const [host, { keys }] of tags) {
    if (new Set(keys).size !== keys.length) {
      throw new Error(`ホスト ${host} の data-om のキーが重複しています: ${keys.join(" ")}`);
    }
    for (const key of keys) {
      if (!sent.has(`${host} ${key}`)) {
        throw new Error(`ホスト ${host} の data-om のキー ${key} の値を送りませんでした。`);
      }
    }
  }
}

/** ストリームのチャンクを、受け取った順に文字列の配列にし、出力の順序の前提に合うことを確認する。 */
export async function read(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  checkOrder(chunks);
  return chunks;
}

/** レスポンスの本文を読み、出力の順序の前提に合うことを確認してから返す。 */
export async function readText(response: Response): Promise<string> {
  if (!response.body) throw new Error("レスポンスに本文がありません。");
  return (await read(response.body)).join("");
}
