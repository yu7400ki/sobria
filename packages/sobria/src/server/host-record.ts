import { BOUNDARIES_KEY } from "../shared/transfer-keys.ts";

/** 要素のホストごとの状態を表す。 */
export class HostRecord {
  /** 開始タグを作成する前に、`data-om` に列挙するキーを集める。開始タグを作成した後は `undefined` である。 */
  private listed: { readonly memo: string[]; readonly child: string[] } | undefined = {
    memo: [],
    child: [],
  };
  /** Shadow DOM の中で後送りにして、まだ送り終えていない境界の数である。 */
  private deferred = 0;
  /**
   * ホストをページに出力したら、開始タグの `data-om` に列挙したキーのうち、まだ値を送っていないものの集合に解決する。
   * 出力しないことが決まったら `false` に解決する。
   */
  private readonly settled = Promise.withResolvers<Set<string> | false>();

  constructor(
    readonly id: string,
    readonly tag: string,
  ) {}

  /** 開始タグを作成する前なら、キーのある非同期の memo のキー `key` を `data-om` に列挙するキーに加える。加えたら真を返す。 */
  listMemo(key: string): boolean {
    if (!this.listed || this.listed.memo.includes(key)) return false;
    this.listed.memo.push(key);
    return true;
  }

  /** 開始タグを作成する前なら、`@c:キー` の `key` を `data-om` に列挙するキーに加える。加えたら真を返す。 */
  listChild(key: string): boolean {
    if (!this.listed) return false;
    this.listed.child.push(key);
    return true;
  }

  /**
   * 集めたキーに、後送りの境界を待つなら `@b` を、さらに `extra` を加えて、`data-om` に列挙するキーとして確定し、その列を返す。
   * `hide` を先に呼び出していなければ、`shown` が真に解決したときに、ホストをページに出力したことを決める。
   */
  seal(extra: readonly string[], shown: Promise<boolean>): string[] {
    if (!this.listed) throw new Error(`ホスト ${this.id} の開始タグを 2 回作成しました。`);
    const keys = [
      ...this.listed.memo,
      ...this.listed.child,
      ...(this.deferred > 0 ? [BOUNDARIES_KEY] : []),
      ...extra,
    ];
    this.listed = undefined;
    const unsent = new Set(keys);
    this.settled.resolve(shown.then((output) => output && unsent));
    return keys;
  }

  /** Shadow DOM の中で後送りにした境界を 1 つ数える。 */
  defer(): void {
    this.deferred++;
  }

  /** 後送りにした境界を 1 つ送り終えたものとして数え、すべて送り終えたら真を返す。 */
  release(): boolean {
    this.deferred--;
    return this.deferred === 0;
  }

  /** 開始タグを作成する前なら、ホストをページに出力しないことを決める。 */
  hide(): void {
    this.settled.resolve(false);
  }

  /** ホストをページに出力し、`key` の値をまだ送っていなければ、送ったものとして記録して真に解決する。 */
  async take(key: string): Promise<boolean> {
    const unsent = await this.settled.promise;
    return unsent !== false && unsent.delete(key);
  }
}

/** ホストの列を、ホストの ID の列にする。 */
export const hostIds = (path: readonly HostRecord[]): string[] => path.map((host) => host.id);
