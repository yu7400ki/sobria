import type { Context } from "hono";

import { closeIterator } from "../shared/objects.ts";
import { getContext, runInRequest } from "./context.ts";

/**
 * サーバーで、handler や memo の関数が返した async iterable を反復する。iterator の `next()` と `return()` は、作成した時点のリクエストの Context の中で呼ぶ。
 * 最初の値は `first` で受け取る。2 番目以降の値は `rest` で受け取る。`close` を呼ぶと、反復を終える。
 */
export class Relay {
  private readonly iterator: AsyncIterator<unknown>;
  private readonly context: Context | undefined;
  /** iterator が終わったか失敗したら真である。 */
  private finished = false;
  /** `close` が返す Promise である。`close` を呼ぶまでは `undefined` である。 */
  private returned: Promise<void> | undefined;
  /** 最初の `next()` の結果である。 */
  readonly first: Promise<IteratorResult<unknown>>;

  constructor(source: AsyncIterable<unknown>) {
    this.context = getContext();
    this.iterator = source[Symbol.asyncIterator]();
    this.first = this.next();
    this.first.catch(() => {});
  }

  /** `close` を呼んだら真である。 */
  private get closing(): boolean {
    return this.returned !== undefined;
  }

  /** 2 番目以降の値を yield する。最初の `next()` で終わったときと、`close` を呼んだ後は、値を yield せずに終わる。 */
  async *rest(): AsyncGenerator<unknown, void> {
    if ((await this.first).done === true) return;
    while (!this.closing) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.next();
      if (result.done === true || this.closing) return;
      yield result.value;
    }
  }

  /** 反復を終える。iterator が終わっていなければ、`return()` を 1 回だけ呼ぶ。返す Promise は、`return()` が終わると解決する。 */
  close(): Promise<void> {
    if (this.returned === undefined) {
      this.returned = this.finished
        ? Promise.resolve()
        : this.run(() => closeIterator(this.iterator));
    }
    return this.returned;
  }

  /** iterator の `next()` を呼び、iterator が終わったか失敗したことを記録する。 */
  private async next(): Promise<IteratorResult<unknown>> {
    try {
      const result = await this.run(() => this.iterator.next());
      if (result.done === true) this.finished = true;
      return result;
    } catch (error) {
      this.finished = true;
      throw error;
    }
  }

  /** `fn` を、作成した時点のリクエストの Context の中で実行する。リクエストの外で作成したときは、そのまま実行する。 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.context ? runInRequest(this.context, fn) : fn();
  }
}
