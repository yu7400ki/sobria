import { fromJSON, toJSON } from "seroval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { startRewrite } from "../../src/client/refresh.ts";
import { serverFn } from "../../src/client/server-fn.ts";
import { toRpcInput } from "../../src/client/wire-codec.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { runSeeding } from "../../src/shared/scope.ts";
import { ServerFnError } from "../../src/shared/server-fn.ts";
import { toNode } from "./nodes.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 反復可能なクラスである。 */
class Pages {
  *[Symbol.iterator]() {
    yield 1;
  }
}

/** Map を継承したクラスである。 */
class Lookup extends Map<string, number> {}

/** Uint8Array を継承したクラスである。 */
class Bytes extends Uint8Array {}

/** ページの番号を返すジェネレーターである。 */
function* pageNumbers() {
  yield 1;
}

const rpcHeaders = { "content-type": "application/json", "x-rinka-wire": "rpc" };

/** `fetch` を、`response` を返す関数に差し替え、受け取ったリクエストを返す関数を返す。 */
function stubFetch(response: () => Response): () => Request {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(new Request(new URL(url, location.href), init));
      return response();
    }),
  );
  return () => {
    const [request] = requests;
    if (!request) throw new Error("fetch が呼ばれていません");
    return request;
  };
}

/** `<title>` を `title` にする描き直しの JSON を返す。 */
const pageTitled = (title: string) => ({
  head: `<title>${title}</title>`,
  body: document.body.innerHTML,
  data: {},
  elements: [],
  doc: { html: {}, body: {} },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("serverFn", () => {
  it("POST は、入力を本文の JSON にして送り、{ ok } の値を返す", async () => {
    const sent = stubFetch(() => Response.json({ ok: 42 }, { headers: rpcHeaders }));
    const like = serverFn("src/fns.ts#like", "POST");
    expect(await like(21, { headers: { "x-a": "b" }, refresh: false })).toBe(42);
    const request = sent();
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/_rinka/fn/src%2Ffns.ts%23like");
    expect(request.headers.get("x-a")).toBe("b");
    expect(request.headers.get("x-rinka-wire")).toBeNull();
    expect(await request.json()).toBe(21);
  });

  it("GET は、入力を ?d= の JSON にして送る", async () => {
    const sent = stubFetch(() => Response.json({ ok: "u" }, { headers: rpcHeaders }));
    expect(await serverFn("src/fns.ts#get", "GET")({ id: 1 })).toBe("u");
    const request = sent();
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("d")).toBe('{"id":1}');
  });

  it("素の JSON で表せない入力は、GET では ?s= に、POST では multipart の input の部分に、seroval の形式で送る。{ s } の値を読む", async () => {
    const date = new Date("2026-01-02T00:00:00Z");
    const sentGet = stubFetch(() => Response.json({ s: toJSON(date) }, { headers: rpcHeaders }));
    expect(await serverFn("src/fns.ts#get", "GET")(date)).toEqual(date);
    expect(JSON.parse(new URL(sentGet().url).searchParams.get("s") ?? "")).toEqual(toJSON(date));

    const sentPost = stubFetch(() => Response.json({ ok: null }, { headers: rpcHeaders }));
    await serverFn("src/fns.ts#post", "POST")(new Map([["a", 1]]), { refresh: false });
    const request = sentPost();
    expect(request.headers.get("x-rinka-wire")).toBeNull();
    const parts = await request.formData();
    expect([...parts.keys()]).toEqual(["input"]);
    expect(JSON.parse(parts.get("input") as string)).toEqual(toJSON(new Map([["a", 1]])));
  });

  it("Blob を含む入力は、Blob を参照にした seroval の JSON の input の部分と、Blob の番号の部分を持つ multipart で送る", async () => {
    const sent = stubFetch(() => Response.json({ ok: null }, { headers: rpcHeaders }));
    const photo = new File(["photo"], "photo.png", { type: "image/png" });
    const note = new Blob(["note"], { type: "text/plain" });
    await serverFn("src/fns.ts#upload", "POST")(
      { photo, pages: [note, photo] },
      { refresh: false },
    );
    const request = sent();
    expect(request.headers.get("content-type")?.startsWith("multipart/form-data; boundary=")).toBe(
      true,
    );
    expect(request.headers.get("x-rinka-wire")).toBeNull();
    const parts = await request.formData();
    expect([...parts.keys()]).toEqual(["input", "0", "1"]);
    const first = parts.get("0") as File;
    const second = parts.get("1") as File;
    expect([first.name, first.type, await first.text()]).toEqual([
      "photo.png",
      "image/png",
      "photo",
    ]);
    expect([second.type, await second.text()]).toEqual(["text/plain", "note"]);
    expect(JSON.parse(parts.get("input") as string)).toEqual(
      toRpcInput({ photo, pages: [note, photo] }).json,
    );
  });

  it("GET の入力に Blob を含めると、送信する前に TypeError を投げる", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      serverFn("src/fns.ts#get", "GET")({ photo: new File(["x"], "x.txt") }),
    ).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("入力に、seroval が型を保てない反復可能なオブジェクトを含めると、送信する前に TypeError を投げる", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    vi.stubGlobal("fetch", fetchMock);
    const withFile = new FormData();
    withFile.append("photo", new File(["x"], "x.txt"));
    const withText = new FormData();
    withText.append("title", "x");
    const values = [
      ["FormData", withFile],
      ["FormData", withText],
      ["URLSearchParams", new URLSearchParams("a=1")],
      ["Headers", new Headers({ a: "1" })],
      ["Pages", new Pages()],
      ["Generator", pageNumbers()],
      ["ReadableStream", new ReadableStream()],
      ["Lookup", new Lookup()],
      ["Bytes", new Bytes(1)],
    ] as const;
    const messages = await Promise.all(
      values.map(async ([, value]) => {
        const error: unknown = await serverFn("src/fns.ts#post", "POST")(
          { value },
          { refresh: false },
        ).catch((caught: unknown) => caught);
        return error instanceof TypeError ? error.message : error;
      }),
    );
    for (const [index, [name]] of values.entries()) expect(messages[index]).toContain(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送信する前に拒否する反復可能なオブジェクトは、seroval が往復させるとプロトタイプが変わるものと一致する", () => {
    // seroval を更新して型を保つクラスが変わったら、wire-codec.ts の一覧と一致しなくなるので失敗する
    const float16: unknown = Reflect.get(globalThis, "Float16Array");
    const candidates: object[] = [
      new Map(),
      new Set(),
      new String("x"),
      new Int8Array(1),
      new Int16Array(1),
      new Int32Array(1),
      new Uint8Array(1),
      new Uint16Array(1),
      new Uint32Array(1),
      new Uint8ClampedArray(1),
      new Float32Array(1),
      new Float64Array(1),
      new BigInt64Array(1),
      new BigUint64Array(1),
      ...(typeof float16 === "function" ? [Reflect.construct(float16, [1]) as object] : []),
      new Lookup(),
      new Bytes(1),
      new Pages(),
      pageNumbers(),
      new FormData(),
      new Headers(),
      new URLSearchParams("a=1"),
      { *[Symbol.iterator]() {} },
    ];
    for (const value of candidates) {
      const kept = Object.getPrototypeOf(fromJSON(toJSON(value))) === Object.getPrototypeOf(value);
      const rejected = (() => {
        try {
          toRpcInput(value);
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      })();
      expect([Object.prototype.toString.call(value), rejected]).toEqual([
        Object.prototype.toString.call(value),
        !kept,
      ]);
    }
  });

  it("Map、Set、型付き配列、String のオブジェクト、反復可能なプレーンなオブジェクトとそれを継承したオブジェクトは、拒否せずに送る", async () => {
    const sent = stubFetch(() => Response.json({ ok: null }, { headers: rpcHeaders }));
    const iterable = { *[Symbol.iterator]() {} };
    await serverFn("src/fns.ts#post", "POST")(
      {
        map: new Map([["a", 1]]),
        set: new Set([1]),
        bytes: new Uint8Array([1]),
        text: new String("x"),
        iterable,
        derived: Object.create(iterable) as object,
      },
      { refresh: false },
    );
    expect((await sent().formData()).has("input")).toBe(true);
  });

  it("signal を fetch に渡す", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    vi.stubGlobal("fetch", fetchMock);
    await serverFn("src/fns.ts#ping", "POST")(undefined, {
      signal: controller.signal,
      refresh: false,
    });
    expect(fetchMock.mock.calls[0]?.at(1)).toMatchObject({ signal: controller.signal });
  });

  it("rinka の RPC の形式でない本文は、TypeError を投げる", async () => {
    stubFetch(() => Response.json({ other: 1 }, { headers: rpcHeaders }));
    await expect(serverFn("src/fns.ts#ping", "POST")()).rejects.toThrow(TypeError);
  });

  it("入力が無ければ、本文とクエリを付けずに送る", async () => {
    const sent = stubFetch(() => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    await serverFn("src/fns.ts#ping", "POST")(undefined, { refresh: false });
    expect(await sent().text()).toBe("");
  });

  it("2xx 以外は、status、パースした本文、Response を持つ ServerFnError を投げる", async () => {
    stubFetch(() =>
      Response.json({ issues: [{ message: "x" }] }, { status: 422, headers: rpcHeaders }),
    );
    const error: unknown = await serverFn(
      "src/fns.ts#like",
      "POST",
    )(1).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ServerFnError);
    expect((error as ServerFnError).status).toBe(422);
    expect((error as ServerFnError).data).toEqual({ issues: [{ message: "x" }] });
    expect((error as ServerFnError).response.status).toBe(422);

    stubFetch(() => new Response("Unauthorized", { status: 401 }));
    const text: unknown = await serverFn(
      "src/fns.ts#like",
      "POST",
    )(1).catch((thrown: unknown) => thrown);
    expect((text as ServerFnError).data).toBeNull();
  });

  it("x-rinka-wire の無い 2xx は、Response のまま返す", async () => {
    stubFetch(() => new Response("file"));
    const response = await serverFn("src/fns.ts#file", "GET")();
    expect(response).toBeInstanceOf(Response);
    expect(await (response as Response).text()).toBe("file");
  });

  it("{ redirect } を受け取ったら、その URL に移動し、解決しない", async () => {
    stubFetch(() =>
      Response.json(
        { redirect: `${location.pathname}${location.search}#moved` },
        { headers: rpcHeaders },
      ),
    );
    let settled = false;
    void serverFn("src/fns.ts#move", "POST")(undefined, { refresh: false }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitUntil(() => location.hash === "#moved");
      await tick();
      expect(settled).toBe(false);
    } finally {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });

  it("{ redirect } の相対の URL は、エンドポイントの URL を基準に解決する", async () => {
    const original = `${location.pathname}${location.search}`;
    const page = `/a/b/c/d${location.search}`;
    history.replaceState(null, "", page);
    stubFetch(() => Response.json({ redirect: `../..${page}#moved` }, { headers: rpcHeaders }));
    void serverFn("src/fns.ts#move", "POST")(undefined, { refresh: false });
    try {
      await vi.waitUntil(() => location.hash === "#moved");
      expect(location.pathname).toBe("/a/b/c/d");
    } finally {
      history.replaceState(null, "", original);
    }
  });

  it("シードの間は通信せず、解決しない Promise を返す", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    runSeeding(() => {
      void serverFn(
        "src/fns.ts#get",
        "GET",
      )(1).finally(() => {
        settled = true;
      });
    });
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });
});

describe("RPC の描き直し", () => {
  let titleBefore = "";
  beforeEach(() => {
    titleBefore = document.title;
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function(bootstrapSource)();
  });
  afterEach(() => {
    document.title = titleBefore;
    delete (globalThis as { $rinka?: unknown }).$rinka;
  });

  it("GET 以外では x-rinka-page に現在の URL を付与し、GET と refresh: false では付与しない", async () => {
    const pages: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        pages.push(new Headers(init?.headers).get("x-rinka-page"));
        return Response.json({ ok: 1, page: pageTitled("x") }, { headers: rpcHeaders });
      }),
    );
    await serverFn("src/fns.ts#like", "POST")(1);
    await serverFn("src/fns.ts#get", "GET")(1);
    await serverFn("src/fns.ts#like", "POST")(1, { refresh: false });
    expect(pages).toEqual([location.href, null, null]);
  });

  it("{ ok } の page を反映してから値を返す", async () => {
    stubFetch(() => Response.json({ ok: 1, page: pageTitled("liked") }, { headers: rpcHeaders }));
    const value = await serverFn("src/fns.ts#like", "POST")(1);
    expect([value, document.title]).toEqual([1, "liked"]);
  });

  it.each([
    ["入力が無いとき", undefined],
    ["入力が素の JSON で表せないとき", new Map([["a", 1]])],
  ])(
    "%s、呼び出しの後に始まった描き直しを反映済みなら、同じページへの { redirect } は、ページを読み込み直さずに undefined を返す",
    async (_label, input) => {
      const response = Promise.withResolvers<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response.promise),
      );
      const calling = serverFn("src/fns.ts#move", "POST")(input);
      startRewrite()(() => {});
      response.resolve(
        Response.json(
          { redirect: `${location.pathname}${location.search}` },
          { headers: rpcHeaders },
        ),
      );
      expect(await calling).toBeUndefined();
    },
  );

  it("page を含む { redirect } は、移動せずに page を反映し、undefined を返す", async () => {
    const before = location.href;
    stubFetch(() =>
      Response.json(
        { redirect: `${location.pathname}${location.search}`, page: pageTitled("moved") },
        { headers: rpcHeaders },
      ),
    );
    const value = await serverFn("src/fns.ts#move", "POST")();
    expect([value, document.title, location.href]).toEqual([undefined, "moved", before]);
  });
});

const streamHeaders = { "content-type": "application/x-ndjson", "x-rinka-wire": "stream" };

/** `line` を JSON の行にしたバイト列を返す。 */
const encodeLine = (line: unknown) => new TextEncoder().encode(`${JSON.stringify(line)}\n`);

/** `lines` を JSON の行にして、行と文字の境界にかかわらず 5 バイトずつ送るストリームのレスポンスを返す。 */
const streamOf = (lines: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(
          lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        );
        for (let at = 0; at < bytes.length; at += 5) controller.enqueue(bytes.slice(at, at + 5));
        controller.close();
      },
    }),
    { headers: streamHeaders },
  );

/** `iterable` の値をすべて配列にして返す。 */
async function collect(iterable: unknown): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterable as AsyncIterable<unknown>) values.push(value);
  return values;
}

describe("serverFn のストリーム", () => {
  let titleBefore = "";
  beforeEach(() => {
    titleBefore = document.title;
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function(bootstrapSource)();
  });
  afterEach(() => {
    document.title = titleBefore;
    delete (globalThis as { $rinka?: unknown }).$rinka;
  });

  it("x-rinka-wire: stream のレスポンスは、行の値を yield する async iterable に解決し、{ end: true } の page を最後に反映する", async () => {
    document.title = "before";
    stubFetch(() =>
      streamOf([
        { ok: 1 },
        { ok: "値" },
        { s: toJSON(new Date(0)) },
        { end: true, page: pageTitled("streamed") },
      ]),
    );
    const values: unknown[] = [];
    const titles: string[] = [];
    for await (const value of (await serverFn(
      "src/fns.ts#stream",
      "POST",
    )()) as AsyncIterable<unknown>) {
      values.push(value);
      titles.push(document.title);
    }
    expect(values).toEqual([1, "値", new Date(0)]);
    expect([...titles, document.title]).toEqual(["before", "before", "before", "streamed"]);
  });

  it("{ error: true } の行を受け取ったら、ステータスが 500 の ServerFnError を投げる", async () => {
    stubFetch(() => streamOf([{ ok: 1 }, { error: true }]));
    const values: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const value of (await serverFn(
          "src/fns.ts#stream",
          "GET",
        )()) as AsyncIterable<unknown>) {
          values.push(value);
        }
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(values).toEqual([1]);
    expect(error).toBeInstanceOf(ServerFnError);
    expect((error as ServerFnError).status).toBe(500);
  });

  it("反復を途中で終えると、レスポンスの本文の読み取りを中止する", async () => {
    const cancelled = Promise.withResolvers<void>();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ ok: 1 })}\n`));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
          { headers: streamHeaders },
        ),
    );
    for await (const value of (await serverFn(
      "src/fns.ts#stream",
      "GET",
    )()) as AsyncIterable<unknown>) {
      expect(value).toBe(1);
      break;
    }
    await cancelled.promise;
  });

  it("次の値を待っている間に return を呼ぶと、すぐにレスポンスの本文の読み取りを中止し、待っている next は終わりを返す", async () => {
    const cancelled = Promise.withResolvers<void>();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encodeLine({ ok: 1 }));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
          { headers: streamHeaders },
        ),
    );
    const iterable = (await serverFn("src/fns.ts#stream", "GET")()) as AsyncIterable<unknown>;
    const iterator = iterable[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    const waiting = iterator.next();
    const returned = iterator.return?.();
    await cancelled.promise;
    expect([await waiting, await returned]).toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  it("page を含む現在のページへの { redirect } の行は、移動せずに page を反映して反復を終える", async () => {
    const before = location.href;
    stubFetch(() =>
      streamOf([
        { ok: 1 },
        { redirect: `${location.pathname}${location.search}`, page: pageTitled("moved") },
      ]),
    );
    expect(await collect(await serverFn("src/fns.ts#move", "POST")())).toEqual([1]);
    expect([document.title, location.href]).toEqual(["moved", before]);
  });

  it("移動する { redirect } の行を受け取ったら、移動を始めた後に反復を止めたままにする", async () => {
    const before = location.href;
    stubFetch(() =>
      streamOf([{ ok: 1 }, { redirect: `${location.pathname}${location.search}#streamed-away` }]),
    );
    const values: unknown[] = [];
    const iterated = (async () => {
      for await (const value of (await serverFn(
        "src/fns.ts#move",
        "GET",
      )()) as AsyncIterable<unknown>) {
        values.push(value);
      }
      return "finished";
    })();
    const settled = await Promise.race([
      iterated,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    const { hash } = location;
    history.replaceState(null, "", before);
    expect([settled, values, hash]).toEqual(["pending", [1], "#streamed-away"]);
  });

  it("{ end: true } の page は、反復の途中で始まった別の呼び出しの page より後に反映する", async () => {
    const ended = Promise.withResolvers<void>();
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 2) {
        return new Response(JSON.stringify({ ok: "other", page: pageTitled("other") }), {
          headers: { "content-type": "application/json", "x-rinka-wire": "rpc" },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encodeLine({ ok: 1 }));
            await ended.promise;
            controller.enqueue(encodeLine({ end: true, page: pageTitled("streamed") }));
            controller.close();
          },
        }),
        { headers: streamHeaders },
      );
    });
    const values: unknown[] = [];
    for await (const value of (await serverFn(
      "src/fns.ts#stream",
      "POST",
    )()) as AsyncIterable<unknown>) {
      values.push(value);
      values.push(await serverFn("src/fns.ts#other", "POST")());
      ended.resolve();
    }
    expect([values, document.title]).toEqual([[1, "other"], "streamed"]);
  });
});

describe("クライアントの form の action に渡したサーバー関数", () => {
  it("action を出力せず、サーバー関数の ID を持つ hidden input を最初の子にし、method を post に、enctype を multipart/form-data にする", () => {
    const save = serverFn("src/fns.ts#save", "POST");
    const form = toNode<HTMLFormElement>(
      clientJsx("form", { action: save, children: clientJsx("input", { name: "a" }) }),
    );
    expect(form.hasAttribute("action")).toBe(false);
    expect(form.innerHTML).toBe(
      '<input type="hidden" name="_rinka_fn" value="src/fns.ts#save"><input name="a">',
    );
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    const encoded = toNode<HTMLFormElement>(
      clientJsx("form", {
        action: save,
        enctype: "application/x-www-form-urlencoded",
      }),
    );
    expect(encoded.getAttribute("enctype")).toBe("application/x-www-form-urlencoded");
  });
});
