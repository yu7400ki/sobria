import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { effect } from "../../src/client/effect.ts";
import { action, optimistic, signal } from "../../src/shared/signals.ts";

describe("effect", () => {
  it("後始末の関数を、次の実行の前と破棄のときに呼ぶ", () => {
    const log: string[] = [];
    const [count, setCount] = signal(0);
    const dispose = createRoot((disposeRoot) => {
      effect(() => {
        const n = count();
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

  it("action の中で optimistic に書き込むと、書き込んだ値で実行し、action が終わると確定した値で実行する", async () => {
    const seen: unknown[] = [];
    const [liked, setLiked] = optimistic(false);
    const [count, setCount] = signal(0);
    createRoot(() => {
      effect(() => {
        seen.push([liked(), count()]);
      });
    });
    flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const like = action(async () => {
      setLiked(true);
      await gate;
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    expect(seen).toEqual([
      [false, 0],
      [true, 0],
      [true, 1],
      [false, 1],
    ]);
  });
});
