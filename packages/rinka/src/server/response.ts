import { classify } from "./errors.ts";
import { Renderer } from "./render.ts";
import { asNode } from "./tree.ts";

/** 描画のオプションを表す。 */
export interface RenderOptions {
  /** すべての `<Loading>` の中身を待ち、中身を埋め込んだ HTML を送る。 */
  readonly blocking?: boolean;
}

/** `node` を描画し、すべての非同期の内容を待ってから、`node` の HTML の文字列を返す。 */
export async function renderToString(node: unknown): Promise<string> {
  const renderer = new Renderer({ kind: "fragment" });
  try {
    return await renderer.shell(asNode(node));
  } finally {
    renderer.dispose();
  }
}

/** `node` を、文書の全体の HTML のストリームとして描画する。シェルを送った後に、後送りの境界を届いた順に送る。 */
export function renderToStream(
  node: unknown,
  options: RenderOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const renderer = new Renderer({
        kind: "document",
        write: (text) => controller.enqueue(encoder.encode(text)),
        blocking: options.blocking ?? false,
      });
      try {
        await renderer.finish(await renderer.shell(asNode(node)), "");
        controller.close();
      } catch (error) {
        renderer.dispose();
        controller.error(error);
      }
    },
  });
}

/** レスポンスのオプションを表す。`P` は、エラーのページを表す値の型である。 */
interface PageOptions<P> extends RenderOptions {
  readonly headers?: Record<string, string>;
  /** シェルの中で `notFound()` を投げたときに、404 で返すページを返す。 */
  readonly notFound?: () => P;
  /** シェルの中で、どの `<Errored>` も受け止めなかったエラーを受け取り、500 で返すページを返す。 */
  readonly error?: (error: unknown) => P;
}

/** レスポンスのオプションを表す。 */
export type ResponseOptions = PageOptions<unknown>;

/**
 * `node` を描画し、シェルが揃った時点で、本文を送り続ける Response を返す。
 * シェルの中で投げた `redirect()` はリダイレクトのレスポンスにし、Response はそのまま返す。
 * `notFound()` は `notFound` のページを 404 で返し、ページが無ければ `Not Found` のテキストを 404 で返す。
 * どの `<Errored>` も受け止めなかったエラーは、`error` のページを 500 で返し、ページが無ければ reject する。
 * `notFound` のページの描画で投げたエラーには `error` のページを使用する。`error` のページの描画で投げた値は、ページを使用せずに、`redirect()` と `notFound()` と Response を同じ規則で扱い、それ以外では reject する。
 */
export function renderToResponse(
  node: unknown,
  { notFound, error, ...options }: ResponseOptions = {},
): Promise<Response> {
  return respond(
    withoutHead(node),
    {
      ...options,
      ...(notFound && { notFound: () => Promise.resolve(withoutHead(notFound())) }),
      ...(error && { error: (thrown: unknown) => Promise.resolve(withoutHead(error(thrown))) }),
    },
    200,
  );
}

/** 文書として描画するノードと、文書の `<head>` の末尾に出力するマークアップを表す。 */
export interface DocumentPage {
  readonly node: unknown;
  readonly head: string;
}

/** `node` を描画し、`<head>` に空の文字列を出力する文書の内容を返す。 */
const withoutHead = (node: unknown): DocumentPage => ({ node, head: "" });

/** 文書のレスポンスのオプションを表す。エラーのページは、そのページの `<head>` のマークアップとともに返す。 */
export type DocumentOptions = PageOptions<Promise<DocumentPage>>;

/**
 * `renderToResponse` と同じ規則で、`page` のノードを描画し、`page` のマークアップを `<head>` の末尾に出力した Response を返す。
 * `notFound` と `error` のページは、そのページのマークアップを `<head>` の末尾に出力する。エラーのページの Promise が reject した値は、シェルの中で投げた値と同じ規則で扱う。
 */
export function renderDocument(page: DocumentPage, options: DocumentOptions): Promise<Response> {
  return respond(page, options, 200);
}

/** `page` を描画した Response を返す。ステータスは、`status` と、シェルの中の `<Errored>` が決めたステータスのうち大きいほうである。 */
async function respond(
  page: DocumentPage | Promise<DocumentPage>,
  options: DocumentOptions,
  status: number,
): Promise<Response> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const renderer = new Renderer({
    kind: "document",
    write: (text) => controller.enqueue(encoder.encode(text)),
    blocking: options.blocking ?? false,
  });
  let resolved: DocumentPage;
  let shell: string;
  try {
    resolved = await page;
    shell = await renderer.shell(asNode(resolved.node));
  } catch (error) {
    renderer.dispose();
    return failure(error, options, respond);
  }
  renderer.finish(shell, resolved.head).then(
    () => controller.close(),
    (error: unknown) => controller.error(error),
  );
  return new Response(body, {
    status: Math.max(status, renderer.status),
    headers: { "content-type": "text/html; charset=utf-8", ...options.headers },
  });
}

/**
 * `node` を描き直して、`refreshPage()` のレスポンスの JSON を返す。`<Loading>` の内側も含めて、すべて揃えてから返す。
 * シェルの中で投げた値は、`renderToResponse` と同じ規則で扱い、`notFound` と `error` のページも描き直しの JSON で返す。
 */
export function renderRefresh(node: unknown, options: ResponseOptions = {}): Promise<Response> {
  return refreshed(node, options, 200);
}

/** `node` を描き直した Response を返す。ステータスは、`status` と、シェルの中の `<Errored>` が決めたステータスのうち大きいほうである。 */
async function refreshed(
  node: unknown,
  options: ResponseOptions,
  status: number,
): Promise<Response> {
  const renderer = new Renderer({ kind: "refresh" });
  try {
    let shell: string;
    try {
      shell = await renderer.shell(asNode(node));
    } catch (error) {
      return await failure(error, options, refreshed);
    }
    return Response.json(await renderer.refresh(shell), {
      status: Math.max(status, renderer.status),
      ...(options.headers && { headers: options.headers }),
    });
  } finally {
    renderer.dispose();
  }
}

/** シェルの中で投げられた値から、レスポンスを作成する。`notFound` と `error` のページは `render` で描画する。 */
function failure<P, O extends PageOptions<P>>(
  error: unknown,
  options: O,
  render: (page: P, options: O, status: number) => Promise<Response>,
): Response | Promise<Response> {
  const thrown = classify(error);
  switch (thrown.kind) {
    case "redirect":
    case "moved":
    case "response":
      return thrown.response;
    case "notFound": {
      const page = options.notFound;
      return page
        ? render(page(), { ...options, notFound: undefined }, 404)
        : new Response("Not Found", { status: 404 });
    }
    case "schema":
    case "error": {
      const page = options.error;
      if (page)
        return render(page(error), { ...options, notFound: undefined, error: undefined }, 500);
      throw error;
    }
  }
}
