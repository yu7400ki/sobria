import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it, vi } from "vitest";

import { effect } from "../../src/client/effect.ts";
import {
  action,
  isPending,
  memo,
  optimistic,
  refresh,
  signal,
  untrack,
  wait,
} from "../../src/shared/signals.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** effect で値を記録し、記録した値の一覧を返す。 */
function watch<T>(read: () => T): T[] {
  const seen: T[] = [];
  effect(read, (value) => {
    seen.push(value);
  });
  return seen;
}

describe("signal と memo", () => {
  it("書き込んだ値は flush するまで読み取りに反映されない", () => {
    const [count, setCount] = signal(0);
    setCount(1);
    expect(count()).toBe(0);
    flush();
    expect(count()).toBe(1);
  });

  it("memo は依存する signal から計算する", () => {
    const [count, setCount] = signal(1);
    const doubled = createRoot(() => memo(() => count() * 2));
    flush();
    expect(doubled()).toBe(2);
    setCount(2);
    flush();
    expect(doubled()).toBe(4);
  });
});

describe("untrack", () => {
  it("effect の apply の中で読むと STRICT_READ_UNTRACKED の警告を出力し、untrack で包んで読むと出力しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [a] = signal(1);
    const [b] = signal(2);
    /** `apply` の中で `read` を呼ぶ effect を作成し、flush した後に出力された警告を返す。 */
    const warnings = (read: () => number) => {
      warn.mockClear();
      createRoot(() =>
        effect(
          () => a(),
          () => {
            read();
          },
        ),
      );
      flush();
      return warn.mock.calls.flat().join(" ");
    };
    expect(warnings(() => b())).toContain("STRICT_READ_UNTRACKED");
    expect(warnings(() => untrack(() => b()))).not.toContain("STRICT_READ_UNTRACKED");
    warn.mockRestore();
  });

  it("untrack は fn の戻り値を返す", () => {
    const [b] = signal(2);
    expect(untrack(() => b() + 1)).toBe(3);
  });

  it("memo の中で untrack で読んだ signal が変化しても、memo を計算し直さない", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(10);
    let runs = 0;
    const sum = createRoot(() =>
      memo(() => {
        runs++;
        return a() + untrack(() => b());
      }),
    );
    const seen = createRoot(() => watch(() => sum()));
    flush();
    setB(20);
    flush();
    expect(seen).toEqual([11]);
    setA(2);
    flush();
    expect(seen).toEqual([11, 22]);
    expect(runs).toBe(2);
  });
});

describe("isPending と refresh", () => {
  it("一度解決した memo が依存の変化で取り直している間だけ、isPending が true になる", async () => {
    const answers: ((value: number) => void)[] = [];
    const [id, setId] = signal(1);
    let pendingSeen: boolean[] = [];
    let value!: () => number;
    createRoot(() => {
      value = memo(() => {
        const current = id();
        return new Promise<number>((resolve) => answers.push((n) => resolve(n + current)));
      });
      pendingSeen = watch(() => isPending(value));
    });
    flush();
    answers[0]?.(0);
    await tick();
    flush();
    expect(value()).toBe(1);

    setId(10);
    flush();
    expect(pendingSeen.at(-1)).toBe(true);
    expect(value()).toBe(1);
    answers[1]?.(0);
    await tick();
    flush();
    expect(value()).toBe(10);
    expect(pendingSeen).toEqual([false, true, false]);
  });

  it("refresh は memo を取り直し、取り直した値で解決する", async () => {
    let count = 0;
    const value = createRoot(() => memo(() => Promise.resolve(++count)));
    flush();
    await tick();
    expect(value()).toBe(1);
    await expect(refresh(value)).resolves.toBe(2);
    flush();
    expect(value()).toBe(2);
  });
});

describe("action と optimistic", () => {
  it("optimistic の書き込みはすぐに反映され、action が終わると元の値に戻る", async () => {
    const done = Promise.withResolvers<void>();
    const [count] = signal(1);
    let shown!: () => number;
    let seen: number[] = [];
    let save!: () => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => count());
      shown = value;
      seen = watch(shown);
      save = action(function* () {
        setShown(10);
        yield done.promise;
      });
    });
    flush();
    const running = save();
    flush();
    expect(shown()).toBe(10);
    done.resolve();
    await running;
    flush();
    expect(shown()).toBe(1);
    expect(seen).toEqual([1, 10, 1]);
  });

  it("yield の後の書き込みも、action が終わるまで保留される", async () => {
    const step = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const [count, setCount] = signal(0);
    let run!: () => Promise<void>;
    createRoot(() => {
      run = action(function* () {
        yield step.promise;
        setCount(1);
        yield finish.promise;
      });
    });
    const running = run();
    step.resolve();
    await tick();
    flush();
    expect(count()).toBe(0);
    finish.resolve();
    await running;
    flush();
    expect(count()).toBe(1);
  });

  it("同時に呼び出した action は、すべてが終わったときに一緒に終わる", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const [likes] = signal(0);
    let shown!: () => number;
    let like!: (gate: Promise<void>) => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => likes());
      shown = value;
      like = action(function* (gate: Promise<void>) {
        setShown((n) => n + 1);
        yield gate;
      });
    });
    flush();
    const a = like(first.promise);
    const b = like(second.promise);
    flush();
    expect(shown()).toBe(2);
    first.resolve();
    await a;
    flush();
    expect(shown()).toBe(2);
    second.resolve();
    await b;
    flush();
    expect(shown()).toBe(0);
  });

  it("action の中で refresh を yield で待つと、memo が解決するまで optimistic の値を保つ", async () => {
    let server = 1;
    let fetching = Promise.withResolvers<void>();
    let shown!: () => number;
    let save!: (n: number) => Promise<void>;
    let user!: ReturnType<typeof memo<number>>;
    createRoot(() => {
      user = memo(async () => {
        const value = server;
        await fetching.promise;
        return value;
      });
      const [value, setShown] = optimistic(() => user());
      shown = value;
      save = action(function* (n: number) {
        setShown(n);
        server = n;
        yield refresh(user);
      });
    });
    flush();
    fetching.resolve();
    await tick();
    flush();
    expect(shown()).toBe(1);
    fetching = Promise.withResolvers<void>();
    const running = save(5);
    flush();
    expect(shown()).toBe(5);
    await tick();
    flush();
    expect(user()).toBe(1);
    expect(shown()).toBe(5);
    fetching.resolve();
    await running;
    flush();
    expect(user()).toBe(5);
    expect(shown()).toBe(5);
  });

  it("action が失敗すると optimistic の値は元に戻る", async () => {
    const fail = Promise.withResolvers<void>();
    const [count] = signal(1);
    let shown!: () => number;
    let save!: () => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => count());
      shown = value;
      save = action(function* () {
        setShown(10);
        yield fail.promise;
      });
    });
    flush();
    const running = save();
    flush();
    expect(shown()).toBe(10);
    fail.reject(new Error("失敗"));
    await expect(running).rejects.toThrow("失敗");
    flush();
    expect(shown()).toBe(1);
  });

  it("wait は、Promise が解決した値を返す", async () => {
    let run!: () => Promise<number>;
    createRoot(() => {
      run = action(function* () {
        const value = yield* wait(Promise.resolve(2));
        return value * 10;
      });
    });
    expect(await run()).toBe(20);
  });

  it("wait は、Promise が reject した値を generator の中に投げる", async () => {
    let run!: () => Promise<string>;
    createRoot(() => {
      run = action(function* () {
        try {
          yield* wait(Promise.reject(new Error("失敗")));
          return "解決";
        } catch (error) {
          return (error as Error).message;
        }
      });
    });
    expect(await run()).toBe("失敗");
  });

  it("pending() は呼び出しの実行中だけ true を返す", async () => {
    const done = Promise.withResolvers<void>();
    let save!: ReturnType<typeof action<[], void>>;
    let seen: boolean[] = [];
    createRoot(() => {
      save = action(function* () {
        yield done.promise;
      });
      seen = watch(() => save.pending());
    });
    flush();
    const running = save();
    flush();
    expect(save.pending()).toBe(true);
    done.resolve();
    await running;
    flush();
    expect(save.pending()).toBe(false);
    expect(seen).toEqual([false, true, false]);
  });
});
