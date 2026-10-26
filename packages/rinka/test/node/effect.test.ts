import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { effect } from "../../src/client/effect.ts";
import { action, memo, optimistic, signal } from "../../src/shared/signals.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("effect", () => {
  it("read の値を apply に渡し、後始末の関数を次の apply の前と破棄のときに呼ぶ", () => {
    const log: string[] = [];
    const [count, setCount] = signal(0);
    const dispose = createRoot((disposeRoot) => {
      effect(count, (n) => {
        log.push(`run ${n}`);
        return () => log.push(`cleanup ${n}`);
      });
      return disposeRoot;
    });
    flush();
    setCount(1);
    flush();
    dispose();
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
  });

  it("apply の中で読み取った値は追跡しない", () => {
    const seen: number[] = [];
    const [count, setCount] = signal(0);
    const [other, setOther] = signal(0);
    createRoot(() => {
      effect(count, (n) => {
        seen.push(n + other());
      });
    });
    flush();
    setOther(10);
    flush();
    setCount(1);
    flush();
    expect(seen).toEqual([0, 11]);
  });

  it("非同期の memo と、memo が依存する signal を読むときは、memo が解決するまで apply を呼ばない", async () => {
    const seen: number[][] = [];
    const [a, setA] = signal(1);
    createRoot(() => {
      const m = memo(async () => {
        const value = a();
        await tick();
        return value * 100;
      });
      effect(
        () => [a(), m()],
        (pair) => {
          seen.push(pair);
        },
      );
    });
    flush();
    await tick();
    flush();
    setA(2);
    flush();
    await tick();
    flush();
    expect(seen).toEqual([
      [1, 100],
      [2, 200],
    ]);
  });

  it("action の中で optimistic に書き込むと、書き込んだ値で apply を呼び、action が終わると確定した値で呼ぶ", async () => {
    const seen: unknown[] = [];
    const [liked, setLiked] = optimistic(false);
    const [count, setCount] = signal(0);
    createRoot(() => {
      effect(
        () => [liked(), count()],
        (pair) => {
          seen.push(pair);
        },
      );
    });
    flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const like = action(function* () {
      setLiked(true);
      setCount(1);
      yield gate;
    });
    const done = like();
    flush();
    await Promise.resolve();
    flush();
    expect(seen).toEqual([
      [false, 0],
      [true, 0],
    ]);
    release();
    await done;
    await tick();
    flush();
    expect(seen).toEqual([
      [false, 0],
      [true, 0],
      [false, 1],
    ]);
  });

  // @solidjs/signals 2.0.0-rc.15 の createEffect は、確定した値で apply を 2 回呼ぶ
  it.fails("action の中で optimistic に書き込み、yield の後で signal に書き込んでも、action が終わったときに確定した値で apply を 1 回だけ呼ぶ", async () => {
    const seen: unknown[] = [];
    const [liked, setLiked] = optimistic(false);
    const [count, setCount] = signal(0);
    createRoot(() => {
      effect(
        () => [liked(), count()],
        (pair) => {
          seen.push(pair);
        },
      );
    });
    flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const like = action(function* () {
      setLiked(true);
      yield gate;
      setCount(1);
    });
    const done = like();
    flush();
    await Promise.resolve();
    flush();
    expect(seen).toEqual([
      [false, 0],
      [true, 0],
    ]);
    release();
    await done;
    await tick();
    flush();
    expect(seen).toEqual([
      [false, 0],
      [true, 0],
      [false, 1],
    ]);
  });
});
