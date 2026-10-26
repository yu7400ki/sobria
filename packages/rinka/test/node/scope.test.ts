import { createRoot, createSignal, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { createScope, isSeeding, memoOf, runSeeding, withScope } from "../../src/shared/scope.ts";
import { siteMemo as memo } from "../../src/shared/signals.ts";

/** memo を作成するたびにキーを記録する描画の範囲を作成する。 */
function recordingScope() {
  const keys: string[] = [];
  const scope = createScope((key, fn) => {
    keys.push(key);
    return memoOf(fn);
  });
  return { scope, keys };
}

describe("memo のキー", () => {
  it("描画の範囲の中では、呼び出し箇所と、その箇所で何回目に作成したかをキーにする", () => {
    const { scope, keys } = recordingScope();
    withScope(scope, () => {
      memo(() => 1, { site: "a.tsx:1:1" });
      memo(() => 2, { site: "a.tsx:2:1" });
      memo(() => 3, { site: "a.tsx:1:1" });
    });
    expect(keys).toEqual(["a.tsx:1:1#0", "a.tsx:2:1#0", "a.tsx:1:1#1"]);
  });

  it("明示的なキーは、そのままキーにし、呼び出し箇所の回数に数えない", () => {
    const { scope, keys } = recordingScope();
    withScope(scope, () => {
      memo(() => 1, { key: "user", site: "a.tsx:1:1" });
      memo(() => 2, { site: "a.tsx:1:1" });
    });
    expect(keys).toEqual(["user", "a.tsx:1:1#0"]);
  });

  it("回数は描画の範囲ごとに数える", () => {
    const first = recordingScope();
    const second = recordingScope();
    withScope(first.scope, () => memo(() => 1, { site: "a.tsx:1:1" }));
    withScope(second.scope, () => memo(() => 1, { site: "a.tsx:1:1" }));
    expect([first.keys, second.keys]).toEqual([["a.tsx:1:1#0"], ["a.tsx:1:1#0"]]);
  });

  it("入れ子の描画の範囲で数えた回数は、外側の範囲の回数に影響しない", () => {
    const outer = recordingScope();
    const inner = recordingScope();
    withScope(outer.scope, () => {
      memo(() => 1, { site: "a.tsx:1:1" });
      withScope(inner.scope, () => memo(() => 2, { site: "a.tsx:1:1" }));
      memo(() => 3, { site: "a.tsx:1:1" });
    });
    expect([outer.keys, inner.keys]).toEqual([["a.tsx:1:1#0", "a.tsx:1:1#1"], ["a.tsx:1:1#0"]]);
  });

  it("キーの無い memo と、描画の範囲の外の memo は、描画の範囲を使わずに作成する", () => {
    const { scope, keys } = recordingScope();
    createRoot(() => {
      const inside = withScope(scope, () => memo(() => 1));
      const outside = memo(() => 2, { site: "a.tsx:1:1" });
      expect([inside(), outside()]).toEqual([1, 2]);
    });
    expect(keys).toEqual([]);
  });

  it("withScope は、関数が例外を投げても、前の描画の範囲に戻す", () => {
    const outer = recordingScope();
    const inner = recordingScope();
    withScope(outer.scope, () => {
      expect(() =>
        withScope(inner.scope, () => {
          throw new Error("x");
        }),
      ).toThrow("x");
      memo(() => 1, { site: "a.tsx:1:1" });
    });
    expect([outer.keys, inner.keys]).toEqual([["a.tsx:1:1#0"], []]);
  });
});

describe("シード", () => {
  it("isSeeding は、runSeeding の関数を実行している間だけ true を返す", () => {
    const seen: boolean[] = [isSeeding()];
    runSeeding(() => seen.push(isSeeding()));
    seen.push(isSeeding());
    expect(seen).toEqual([false, true, false]);
  });
});

/** 値を 1 つずつ渡すと yield する async iterable と、反復を終えたかどうかを返す。 */
function channel<T>() {
  const pending: PromiseWithResolvers<T>[] = [Promise.withResolvers<T>()];
  const state = { closed: false };
  async function* values(): AsyncGenerator<T> {
    try {
      for (let i = 0; ; i++) {
        // oxlint-disable-next-line no-await-in-loop
        yield await pending[i]!.promise;
      }
    } finally {
      state.closed = true;
    }
  }
  const send = (value: T) => {
    pending.at(-1)!.resolve(value);
    pending.push(Promise.withResolvers<T>());
  };
  return { values, send, state };
}

/** マイクロタスクとタイマーを進めてから flush する。 */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
};

/** `read` が返す値か、投げた値の名前を返す。 */
const peek = (read: () => unknown): unknown => {
  try {
    return read();
  } catch (error) {
    return (error as Error).constructor.name;
  }
};

describe("memoOf", () => {
  it("async iterable と、async iterable に解決する Promise は、yield した値に置き換わる", async () => {
    const direct = channel<number>();
    const wrapped = channel<number>();
    let first!: () => number;
    let second!: () => number;
    createRoot(() => {
      first = memoOf(() => direct.values());
      second = memoOf(() => Promise.resolve(wrapped.values()));
    });
    flush();
    expect([peek(first), peek(second)]).toEqual(["NotReadyError", "NotReadyError"]);
    direct.send(1);
    wrapped.send(1);
    await settle();
    expect([peek(first), peek(second)]).toEqual([1, 1]);
    direct.send(2);
    wrapped.send(2);
    await settle();
    expect([peek(first), peek(second)]).toEqual([2, 2]);
  });

  it("loadingValue を渡すと、保留中にならずにその値を返し、その後に yield した値に置き換わる", async () => {
    const source = channel<number>();
    let read!: () => number;
    createRoot(() => {
      read = memoOf(() => source.values(), { loadingValue: 1 });
    });
    flush();
    expect(peek(read)).toBe(1);
    await settle();
    expect(peek(read)).toBe(1);
    source.send(2);
    await settle();
    expect(peek(read)).toBe(2);
  });

  it("Promise が async iterable に解決する前に memo を計算し直すか破棄すると、解決した iterable の return を呼ぶ", async () => {
    const returned: number[] = [];
    const iterableOf = (index: number): AsyncIterable<number> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => {
          returned.push(index);
          return { done: true, value: undefined };
        },
      }),
    });
    const pending = [
      Promise.withResolvers<AsyncIterable<number>>(),
      Promise.withResolvers<AsyncIterable<number>>(),
    ];
    const [version, setVersion] = createSignal(0);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      memoOf(() => pending[version()]!.promise);
    });
    flush();
    setVersion(1);
    flush();
    pending[0]!.resolve(iterableOf(0));
    await settle();
    dispose();
    pending[1]!.resolve(iterableOf(1));
    await settle();
    expect(returned).toEqual([0, 1]);
  });

  it("memo を計算し直すか破棄すると、iterable の return を呼ぶ", async () => {
    const sources = [channel<number>(), channel<number>()];
    const [version, setVersion] = createSignal(0);
    let dispose!: () => void;
    let read!: () => number;
    createRoot((d) => {
      dispose = d;
      read = memoOf(() => sources[version()]!.values());
    });
    flush();
    sources[0]!.send(1);
    await settle();
    expect(peek(read)).toBe(1);
    setVersion(1);
    flush();
    sources[0]!.send(9);
    await settle();
    expect(sources[0]!.state.closed).toBe(true);
    sources[1]!.send(2);
    await settle();
    expect(peek(read)).toBe(2);
    expect(sources[1]!.state.closed).toBe(false);
    dispose();
    sources[1]!.send(3);
    await settle();
    expect(sources[1]!.state.closed).toBe(true);
  });
});
