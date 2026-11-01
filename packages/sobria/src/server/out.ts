import type { Delivery } from "../shared/element.ts";

/** 起動スクリプトに伝える要素を表す。`immediate` は、すぐ起動するインスタンスが 1 つでもあれば真である。 */
export interface Delivered {
  readonly tag: string;
  readonly delivery: Delivery;
  readonly immediate: boolean;
}

/** 出力を送るチャンクを表す。シェルか、後送りの境界の中身である。 */
export type Flush = ShellFlush | DeferredFlush;

/** チャンクがページに現れるかどうかを表す `shown` と、それを解決する `resolve` の組を表す。 */
interface Resolvable {
  /** チャンクを書き込んだら `true` に、書き込まないことが決まったら `false` に解決する。 */
  readonly shown: Promise<boolean>;
  readonly resolve: (shown: boolean) => void;
}

/** シェルを送るチャンクを表す。 */
export interface ShellFlush extends Resolvable {
  readonly kind: "shell";
  /** シェルにその場に出力した境界の中身の中で、`notFound()` を受け止めたことを表す。 */
  noindex: boolean;
}

/** 後送りの境界の中身を送るチャンクを表す。 */
export interface DeferredFlush extends Resolvable {
  readonly kind: "deferred";
  /** 中身の中で `notFound()` を受け止めたことを表す。 */
  noindex: boolean;
}

/** `source` の要素を、タグ名ごとに `target` に加える。同じタグなら、どちらかがすぐ起動するインスタンスを持つときに `immediate` を真にする。 */
export function mergeDelivered(target: Map<string, Delivered>, source: Iterable<Delivered>): void {
  for (const delivered of source) {
    const current = target.get(delivered.tag);
    if (!current || (!current.immediate && delivered.immediate))
      target.set(delivered.tag, delivered);
  }
}

/** 解決していない `Resolvable` を作成する。 */
export function resolvable(): Resolvable {
  const resolvers = Promise.withResolvers<boolean>();
  return { shown: resolvers.promise, resolve: resolvers.resolve };
}

/**
 * 出力の位置を表す。`flush` は、この位置の出力を送るチャンクである。
 * `shown` は、この位置の出力がページに現れたら `true` に、現れないことが決まったら `false` に解決する。
 * どの位置の `shown` も、外側の位置の `shown` より先には解決しない。
 * `shown` が `true` に解決する時点で、この位置の文字列化は終わっている。
 */
export class Out {
  /** `Out` を、同じ形のオブジェクトと区別する。 */
  declare private readonly nominal: never;
  /** この位置の出力と同じ書き込みで、出力の後に書き込むスクリプトである。 */
  private readonly scripts: string[] = [];
  /** この位置に出力した、起動スクリプトに伝える要素を、タグ名ごとに表す。 */
  private readonly elements = new Map<string, Delivered>();
  /** 描き直しで、この位置に出力したホストの ID ごとに、`data` に入れる JS の式を表す。 */
  private readonly refreshData = new Map<string, string>();

  /** 出力の後に書き込むスクリプトを加える。 */
  addScript(script: string): void {
    this.scripts.push(script);
  }

  /** 起動スクリプトに伝える要素を加える。 */
  addElement(delivered: Delivered): void {
    mergeDelivered(this.elements, [delivered]);
  }

  /** 描き直しの `data` に入れる、ホストの ID が `id` の props の JS の式を加える。 */
  addRefreshData(id: string, expression: string): void {
    this.refreshData.set(id, expression);
  }

  /** `other` の位置のスクリプト、要素、描き直しの `data` を、この位置に加える。 */
  absorb(other: Out): void {
    this.scripts.push(...other.scripts);
    mergeDelivered(this.elements, other.elements.values());
    for (const [id, expression] of other.refreshData) this.refreshData.set(id, expression);
  }

  /** 描き直しの `data` に入れる、ホストの ID ごとの JS の式である。 */
  get data(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.refreshData);
  }

  /** 出力の後に書き込むスクリプトを連結した文字列である。 */
  get scriptText(): string {
    return this.scripts.join("");
  }

  /** 起動スクリプトに伝える要素である。 */
  get delivered(): Iterable<Delivered> {
    return this.elements.values();
  }

  private constructor(
    readonly flush: Flush,
    readonly shown: Promise<boolean>,
  ) {}

  /** `flush` で送る出力の、最も外側の位置を作成する。 */
  static of(flush: Flush): Out {
    return new Out(flush, flush.shown);
  }

  /** この位置にあり、出力を `flush` で送る位置を作成する。この位置がページに現れ、`flush` のチャンクを書き込んだときに、ページに現れる。 */
  into(flush: Flush): Out {
    return new Out(
      flush,
      this.shown.then(async (output) => output && (await flush.shown)),
    );
  }

  /**
   * この位置のうち、この位置の `shown` が `true` に解決した時点で `kept` が真を返すときだけ、ページに現れる位置を作成する。
   * 戻り値の位置の `scripts` は、呼び出し側がこの位置の `scripts` に追加したときだけ書き込む。
   */
  conditional(kept: () => boolean): Out {
    return new Out(
      this.flush,
      this.shown.then((output) => output && kept()),
    );
  }
}
