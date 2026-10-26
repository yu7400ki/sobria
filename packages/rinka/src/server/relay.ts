/**
 * SSR の memo が返した async iterable を反復する。最初の値は、描画のための `view` と、ホストに送る処理の両方が受け取る。
 * 2 番目以降の値は `rest` だけが受け取る。`close` を呼ぶと、反復を終える。
 */
export class Relay {
  private readonly iterator: AsyncIterator<unknown>;
  private readonly closed = Promise.withResolvers<void>();
  /** iterator が終わったか失敗したら真である。 */
  private finished = false;
  /** `close` を呼んだら真である。 */
  private closing = false;
  /** 最初の `next()` の結果である。 */
  readonly first: Promise<IteratorResult<unknown>>;

  constructor(source: AsyncIterable<unknown>) {
    this.iterator = source[Symbol.asyncIterator]();
    this.first = this.next();
    this.first.catch(() => {});
  }

  /** 最初の値を yield し、`close` が呼ばれるまで終わらない async iterable を返す。最初の値の前に失敗したら、その例外を投げる。 */
  async *view(): AsyncGenerator<unknown, void> {
    const result = await this.first;
    if (result.done === true) return;
    yield result.value;
    await this.closed.promise;
  }

  /** 2 番目以降の値を yield する。`close` を呼んだ後は、値を yield せずに終わる。 */
  async *rest(): AsyncGenerator<unknown, void> {
    while (!this.closing) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.next();
      if (result.done === true || this.closing) return;
      yield result.value;
    }
  }

  /** 反復を終え、`view` にも終わりを伝える。iterator が終わっていなければ、`return()` を 1 回だけ呼ぶ。 */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.closed.resolve();
    if (this.finished) return;
    void Promise.resolve(this.iterator.return?.()).catch(() => {});
  }

  /** iterator の `next()` を呼び、iterator が終わったか失敗したことを記録する。 */
  private async next(): Promise<IteratorResult<unknown>> {
    try {
      const result = await this.iterator.next();
      if (result.done === true) this.finished = true;
      return result;
    } catch (error) {
      this.finished = true;
      throw error;
    }
  }
}
