import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "../../src/server/bootstrap.ts";

/** 起動スクリプトの受け口のうち、要素の一覧と起動の条件を受け取るものを表す。 */
interface Receiver {
  m(list: [tag: string, module: string, load: string][]): void;
  w(el: Element, start: () => void): void;
}

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
  new Function(bootstrap.slice("<script>".length, -"</script>".length))();
  return (globalThis as unknown as { $rinka: Receiver }).$rinka;
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

  it("idle の要素は、requestIdleCallback のコールバックが呼ばれた時点で読み込む", async () => {
    const callbacks: (() => void)[] = [];
    vi.spyOn(window, "requestIdleCallback").mockImplementation((callback) => {
      callbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 0 }));
      return 0;
    });
    const tag = nextTag();
    place(tag);
    receiver().m([[tag, moduleOf(tag), "idle"]]);
    await tick();
    expect(loads(tag)).toBe(0);
    for (const callback of callbacks) callback();
    await vi.waitUntil(() => loads(tag) === 1);
  });

  it("visible の要素は、インスタンスがビューポートに入った時点で読み込む", async () => {
    const tag = nextTag();
    const el = place(tag, undefined, "margin-top: 300vh;");
    receiver().m([[tag, moduleOf(tag), "visible"]]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(loads(tag)).toBe(0);
    el.scrollIntoView();
    await vi.waitUntil(() => loads(tag) === 1);
  });

  it("data-rinka-load の指定は、要素のデフォルトの起動タイミングより優先する", async () => {
    const callbacks: (() => void)[] = [];
    vi.spyOn(window, "requestIdleCallback").mockImplementation((callback) => {
      callbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 0 }));
      return 0;
    });
    const tag = nextTag();
    place(tag, "idle");
    receiver().m([[tag, moduleOf(tag), "load"]]);
    await tick();
    expect(loads(tag)).toBe(0);
    for (const callback of callbacks) callback();
    await vi.waitUntil(() => loads(tag) === 1);
  });

  it("media の指定は、メディアクエリに一致した時点で読み込む", async () => {
    const listeners: (() => void)[] = [];
    const query = { matches: false } as { matches: boolean };
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
    const tag = nextTag();
    place(tag, "media:(min-width: 800px)");
    receiver().m([[tag, moduleOf(tag), "load"]]);
    await tick();
    expect(loads(tag)).toBe(0);
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 800px)");
    query.matches = true;
    for (const listener of listeners) listener();
    await vi.waitUntil(() => loads(tag) === 1);
  });
});

describe("$rinka.w", () => {
  it("インスタンスの起動の条件を満たした時点で start を呼ぶ", async () => {
    const callbacks: (() => void)[] = [];
    vi.spyOn(window, "requestIdleCallback").mockImplementation((callback) => {
      callbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 0 }));
      return 0;
    });
    const tag = nextTag();
    const rinka = receiver();
    rinka.m([[tag, moduleOf(tag), "load"]]);
    const now = place(tag);
    const later = place(tag, "idle");
    const started: Element[] = [];
    rinka.w(now, () => started.push(now));
    rinka.w(later, () => started.push(later));
    expect(started).toEqual([now]);
    for (const callback of callbacks) callback();
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
