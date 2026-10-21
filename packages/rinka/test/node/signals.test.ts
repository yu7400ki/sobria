import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { effect } from "../../src/client/effect.ts";
import { action, isPending, memo, optimistic, refresh, signal } from "../../src/shared/signals.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 解決を外から制御できる Promise。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** effect で値を記録し、記録した値の一覧を返す。 */
function watch<T>(read: () => T): T[] {
  const seen: T[] = [];
  effect(() => {
    seen.push(read());
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
    const done = deferred();
    const [count] = signal(1);
    let shown!: () => number;
    let seen: number[] = [];
    let save!: () => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => count());
      shown = value;
      seen = watch(shown);
      save = action(async () => {
        setShown(10);
        await done.promise;
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

  it("async 関数の await の後の書き込みは、すぐに反映される", async () => {
    const step = deferred();
    const finish = deferred();
    const [count, setCount] = signal(0);
    let run!: () => Promise<void>;
    createRoot(() => {
      run = action(async () => {
        await step.promise;
        setCount(1);
        await finish.promise;
      });
    });
    const running = run();
    step.resolve();
    await tick();
    flush();
    expect(count()).toBe(1);
    finish.resolve();
    await running;
  });

  it("generator の yield の後の書き込みは、action が終わるまで保留される", async () => {
    const step = deferred();
    const finish = deferred();
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
    const first = deferred();
    const second = deferred();
    const [likes] = signal(0);
    let shown!: () => number;
    let like!: (wait: Promise<void>) => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => likes());
      shown = value;
      like = action(async (wait: Promise<void>) => {
        setShown((n) => n + 1);
        await wait;
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

  it("async 関数の最初の await より前の書き込みは、action が終わるまで保留される", async () => {
    const finish = deferred();
    const [count, setCount] = signal(0);
    let run!: () => Promise<void>;
    createRoot(() => {
      run = action(async () => {
        setCount(1);
        await finish.promise;
      });
    });
    const running = run();
    await tick();
    flush();
    expect(count()).toBe(0);
    finish.resolve();
    await running;
    flush();
    expect(count()).toBe(1);
  });

  it("action の中で refresh を await すると、memo が解決するまで optimistic の値を保つ", async () => {
    let server = 1;
    let fetching = deferred();
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
      save = action(async (n: number) => {
        setShown(n);
        server = n;
        await refresh(user);
      });
    });
    flush();
    fetching.resolve();
    await tick();
    flush();
    expect(shown()).toBe(1);
    fetching = deferred();
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
    const fail = deferred();
    const [count] = signal(1);
    let shown!: () => number;
    let save!: () => Promise<void>;
    createRoot(() => {
      const [value, setShown] = optimistic(() => count());
      shown = value;
      save = action(async () => {
        setShown(10);
        await fail.promise;
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

  it("pending() は呼び出しの実行中だけ true を返す", async () => {
    const done = deferred();
    let save!: ReturnType<typeof action<[], void>>;
    let seen: boolean[] = [];
    createRoot(() => {
      save = action(async () => {
        await done.promise;
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
