import { toJSON } from "seroval";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsx as clientJsx } from "../../src/client/jsx-runtime.ts";
import { serverFn } from "../../src/client/server-fn.ts";
import { runSeeding } from "../../src/shared/scope.ts";
import { ServerFnError } from "../../src/shared/server-fn.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("serverFn", () => {
  it("POST は、入力を本文の JSON にして送り、{ ok } の値を返す", async () => {
    const sent = stubFetch(() => Response.json({ ok: 42 }, { headers: rpcHeaders }));
    const like = serverFn("src/fns.ts#like", "POST");
    expect(await like(21, { headers: { "x-a": "b" } })).toBe(42);
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

  it("素の JSON で表せない入力は、GET では ?s= に、POST では x-rinka-wire: seroval を付けた本文に、seroval の形式で送る。{ s } の値を読む", async () => {
    const date = new Date("2026-01-02T00:00:00Z");
    const sentGet = stubFetch(() => Response.json({ s: toJSON(date) }, { headers: rpcHeaders }));
    expect(await serverFn("src/fns.ts#get", "GET")(date)).toEqual(date);
    expect(JSON.parse(new URL(sentGet().url).searchParams.get("s") ?? "")).toEqual(toJSON(date));

    const sentPost = stubFetch(() => Response.json({ ok: null }, { headers: rpcHeaders }));
    await serverFn("src/fns.ts#post", "POST")(new Map([["a", 1]]));
    const request = sentPost();
    expect(request.headers.get("x-rinka-wire")).toBe("seroval");
    expect(await request.json()).toEqual(toJSON(new Map([["a", 1]])));
  });

  it("signal を fetch に渡す", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    vi.stubGlobal("fetch", fetchMock);
    await serverFn("src/fns.ts#ping", "POST")(undefined, { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.at(1)).toMatchObject({ signal: controller.signal });
  });

  it("rinka の RPC の形式でない本文は、TypeError を投げる", async () => {
    stubFetch(() => Response.json({ other: 1 }, { headers: rpcHeaders }));
    await expect(serverFn("src/fns.ts#ping", "POST")()).rejects.toThrow(TypeError);
  });

  it("入力が無ければ、本文とクエリを付けずに送る", async () => {
    const sent = stubFetch(() => Response.json({ ok: 1 }, { headers: rpcHeaders }));
    await serverFn("src/fns.ts#ping", "POST")();
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
    stubFetch(() => Response.json({ redirect: "#moved" }, { headers: rpcHeaders }));
    let settled = false;
    void serverFn("src/fns.ts#move", "POST")().finally(() => {
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

describe("クライアントの form の action に渡したサーバー関数", () => {
  it("action をエンドポイントの URL に、method を post に、enctype を multipart/form-data にする", () => {
    const save = serverFn("src/fns.ts#save", "POST");
    const form = clientJsx("form", { action: save }) as unknown as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/_rinka/fn/src%2Ffns.ts%23save");
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    const encoded = clientJsx("form", {
      action: save,
      enctype: "application/x-www-form-urlencoded",
    }) as unknown as HTMLFormElement;
    expect(encoded.getAttribute("enctype")).toBe("application/x-www-form-urlencoded");
  });
});
