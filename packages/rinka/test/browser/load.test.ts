import { afterEach, describe, expect, it, vi } from "vitest";

import { installRpc, serverFn } from "../../src/client/server-fn.ts";
import { bootstrapSource } from "../../src/server/bootstrap.ts";
import { loadTimings, type LoadTiming } from "../../src/shared/names.ts";
import { receiverKeys, type Receiver } from "../../src/shared/receiver.ts";

/** モジュールを読み込んだ要素のタグ名を、読み込んだ順に列挙する。 */
declare global {
  var loadedTags: string[] | undefined;
}

afterEach(() => {
  document.body.replaceChildren();
  delete (globalThis as { $rinka?: unknown }).$rinka;
  delete globalThis.loadedTags;
  vi.restoreAllMocks();
});

let count = 0;
const nextTag = () => `test-load-${++count}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 起動スクリプトを実行し、受け口を返す。 */
function receiver(): Receiver {
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(bootstrapSource)();
  return globalThis.$rinka!;
}

/** 読み込むと `loadedTags` に `tag` を追加するモジュールの URL を返す。 */
const moduleOf = (tag: string): string =>
  URL.createObjectURL(
    new Blob([`(globalThis.loadedTags ??= []).push(${JSON.stringify(tag)});`], {
      type: "text/javascript",
    }),
  );

/** `tag` のインスタンスを body に追加する。`load` があれば `data-rinka-load` に指定する。 */
function place(tag: string, load?: string, style = ""): HTMLElement {
  const el = document.createElement(tag);
  if (load !== undefined) el.setAttribute("data-rinka-load", load);
  el.style.cssText = `display: block; height: 10px; ${style}`;
  document.body.append(el);
  return el;
}

/** `tag` のモジュールを読み込んだ回数を返す。 */
const loads = (tag: string) => (globalThis.loadedTags ?? []).filter((t) => t === tag).length;

/** 起動のタイミングの条件を表す。`arrange` は条件を満たす準備をして、インスタンスを受け取って条件を満たす関数を返す。 */
interface Condition {
  readonly attribute: string;
  readonly style?: string;
  readonly arrange: () => (el: HTMLElement) => void;
}

/** `requestIdleCallback` を差し替え、登録されたコールバックを呼ぶ関数を返す。 */
function stubIdle(): () => void {
  const callbacks: (() => void)[] = [];
  vi.spyOn(window, "requestIdleCallback").mockImplementation((callback) => {
    callbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 0 }));
    return 0;
  });
  return () => {
    for (const callback of callbacks) callback();
  };
}

const conditions: Record<LoadTiming, Condition> = {
  load: { attribute: "load", arrange: () => () => {} },
  idle: {
    attribute: "idle",
    arrange: () => {
      const run = stubIdle();
      return () => run();
    },
  },
  visible: {
    attribute: "visible",
    style: "margin-top: 300vh;",
    arrange: () => (el) => el.scrollIntoView(),
  },
  media: {
    attribute: "media:(min-width: 800px)",
    arrange: () => {
      const listeners: (() => void)[] = [];
      const query = { matches: false };
      vi.spyOn(window, "matchMedia").mockImplementation(
        (media) =>
          ({
            media,
            get matches() {
              return query.matches;
            },
            addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      return () => {
        expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 800px)");
        query.matches = true;
        for (const listener of listeners) listener();
      };
    },
  },
};

describe("起動スクリプト", () => {
  it("$rinka に、receiverKeys の受け口だけを定義する", () => {
    receiver().m([]);
    expect(Object.keys(globalThis.$rinka ?? {}).toSorted()).toEqual([...receiverKeys].toSorted());
  });
});

describe("$rinka.m", () => {
  it("load の要素は、インスタンスがあればすぐにモジュールを 1 回だけ読み込む", async () => {
    const tag = nextTag();
    place(tag);
    place(tag);
    receiver().m([[tag, moduleOf(tag), "load"]]);
    await vi.waitUntil(() => loads(tag) === 1);
    await tick();
    expect(loads(tag)).toBe(1);
  });

  it("インスタンスが無い要素は、モジュールを読み込まず、後からインスタンスが追加された時点で読み込む", async () => {
    const tag = nextTag();
    receiver().m([[tag, moduleOf(tag), "load"]]);
    await tick();
    expect(loads(tag)).toBe(0);
    const container = document.createElement("div");
    container.innerHTML = `<${tag}></${tag}>`;
    document.body.append(container);
    await vi.waitUntil(() => loads(tag) === 1);
  });

  it("data-rinka-load が無いインスタンスは、一覧のデフォルトの起動タイミングで読み込む", async () => {
    const run = stubIdle();
    const tag = nextTag();
    place(tag);
    receiver().m([[tag, moduleOf(tag), "idle"]]);
    await tick();
    expect(loads(tag)).toBe(0);
    run();
    await vi.waitUntil(() => loads(tag) === 1);
  });

  it.each(loadTimings)(
    "data-rinka-load が %s のインスタンスは、条件を満たした時点でモジュールを 1 回だけ読み込む",
    async (timing) => {
      const condition = conditions[timing];
      const satisfy = condition.arrange();
      const tag = nextTag();
      const el = place(tag, condition.attribute, condition.style);
      receiver().m([[tag, moduleOf(tag), "load"]]);
      if (timing !== "load") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(loads(tag)).toBe(0);
        satisfy(el);
      }
      await vi.waitUntil(() => loads(tag) === 1);
      await tick();
      expect(loads(tag)).toBe(1);
    },
  );
});

describe("$rinka.f", () => {
  it("同じ ID とメソッドには同じ関数を返し、その関数は呼ばれるたびに $rinka.c から RPC の関数を取得して呼ぶ", async () => {
    const rinka = receiver();
    const like = rinka.f("src/fns.ts#like", "POST");
    expect(rinka.f("src/fns.ts#like", "POST")).toBe(like);
    expect(rinka.f("src/fns.ts#like", "GET")).not.toBe(like);
    const calls: unknown[][] = [];
    rinka.c =
      (id, method) =>
      async (...args: unknown[]) => {
        calls.push([id, method, ...args]);
        return "liked";
      };
    expect(await like(1)).toBe("liked");
    expect(calls).toEqual([["src/fns.ts#like", "POST", 1]]);
  });

  it("クライアントのランタイムは、$rinka.c に serverFn を登録する", () => {
    receiver();
    installRpc();
    expect(globalThis.$rinka?.c).toBe(serverFn);
  });
});

describe("$rinka.w", () => {
  it("インスタンスの起動の条件を満たした時点で start を呼ぶ", async () => {
    const run = stubIdle();
    const tag = nextTag();
    const rinka = receiver();
    rinka.m([[tag, moduleOf(tag), "load"]]);
    const now = place(tag);
    const later = place(tag, "idle");
    const started: Element[] = [];
    rinka.w(now, () => started.push(now));
    rinka.w(later, () => started.push(later));
    expect(started).toEqual([now]);
    run();
    expect(started).toEqual([now, later]);
  });

  it("一覧に無いタグのインスタンスは、すぐに start を呼ぶ", () => {
    const el = place(nextTag(), "idle");
    let started = false;
    receiver().w(el, () => {
      started = true;
    });
    expect(started).toBe(true);
  });
});
