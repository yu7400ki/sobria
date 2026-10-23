import {
  createMemo,
  createRoot,
  getOwner,
  NotReadyError,
  resolve,
  runWithOwner,
  untrack,
  type Owner,
} from "@solidjs/signals";

import { attributeValue, tagAttributeName } from "../shared/attributes.ts";
import {
  elementInfo,
  isElementComponent,
  type Ctx,
  type Delivery,
  type ElementComponent,
} from "../shared/element.ts";
import { isEventProp, propToAttribute, reservedProp } from "../shared/names.ts";
import { isFunction } from "../shared/objects.ts";
import type { SwapSpec } from "../shared/receiver.ts";
import { createScope, withScope, type ScopedChild } from "../shared/scope.ts";
import { BOUNDARIES_KEY, childKey, PROPS_KEY } from "../shared/transfer-keys.ts";
import { checkSerializable, formProps } from "../shared/wire.ts";
import {
  bootstrap,
  dataScript,
  listScript,
  loadAttributeName,
  loadAttributeValue,
  noValue,
  swapScript,
} from "./bootstrap.ts";
import { classify } from "./errors.ts";
import { scriptJson } from "./script.ts";
import { asNode, type ErroredNode, type Node } from "./tree.ts";
import { toScript } from "./wire.ts";

/**
 * 出力の単位を表す。文字列、穴、投げられた値、`<Loading>` の位置、`<Errored>` の領域、スロットの内容、要素のホストのいずれかである。
 * 穴は、描画した時点では内容が決まらず、値が解決してから内容が決まる位置である。
 * 後送りの境界は、シェルにはフォールバックを目印で囲んで出力し、中身はシェルの後に出力して、起動スクリプトが目印の間の内容を差し替える。
 */
type Chunk = string | Hole | Fail | Mark | ErroredRegion | Slotted | Host;

/** 穴を表す。`hole` は、内容が決まると出力の単位の列に解決する。 */
interface Hole {
  readonly kind: "hole";
  readonly hole: Promise<Chunk[]>;
}

/** 描画の途中で同期的に投げられた値を表す。文字列にする時点で、保持している値を投げる。 */
interface Fail {
  readonly kind: "fail";
  readonly fail: unknown;
}

/** `<Loading>` の位置を表す。中身を埋め込むか、フォールバックを出力して後送りにするかは、文字列にする時点で決定する。 */
interface Mark {
  readonly kind: "mark";
  readonly mark: Boundary;
  readonly fallback: () => Chunk[];
}

/** `<Errored>` の領域を表す。中身が失敗すると、`node.fallback` が返した内容を出力する。 */
interface ErroredRegion {
  readonly kind: "errored";
  readonly errored: { readonly chunks: Chunk[]; readonly node: ErroredNode; readonly ctx: WalkCtx };
}

/**
 * 要素の Light DOM のうち、Shadow DOM の `<Loading>` の中にある `<slot>` に配置する内容を表す。
 * 境界を後送りにし、内容に穴があれば、目印を出力して、内容の全体を境界の差し替えとして後から出力する。
 */
interface Slotted {
  readonly kind: "slotted";
  readonly slotted: {
    readonly boundary: Boundary;
    readonly chunks: Chunk[];
    /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
    readonly path: readonly HostRecord[];
  };
}

/** 要素のホストの属性を表す。`transfer` は、属性にできない props の値を、props の名前ごとに保持する。 */
interface HostAttributes {
  readonly text: string;
  readonly transfer: Readonly<Record<string, unknown>> | undefined;
}

/** 要素のホストを表す。開始タグは、`chunks` を文字列にした後で、待つ境界を決定してから出力する。 */
interface Host {
  readonly kind: "host";
  readonly host: {
    readonly record: HostRecord;
    readonly attributes: HostAttributes | Promise<HostAttributes>;
    readonly open: (attributes: HostAttributes, shown: Promise<boolean>) => string;
    readonly chunks: Chunk[];
    /** 要素を作成したホストに、開始タグの後で `@c:キー` を送るスクリプトである。 */
    readonly announce: string | undefined;
    /** サーバーコンポーネントが直接使用した、配信の情報を持つ要素なら、起動スクリプトに伝える内容を持つ。 */
    readonly delivered: Delivered | undefined;
  };
}

/** 文書を出力する描画で、特別に扱うタグの扱いを表す。`head` は、`<head>` に移動するタグである。 */
type DocumentTag = "head";

/** 文書を出力する描画で、特別に扱うタグと、その扱いである。 */
const documentTags: ReadonlyMap<string, DocumentTag> = new Map([
  ["title", "head"],
  ["meta", "head"],
  ["link", "head"],
]);

/** 文書を表す。`head` は、文書の `<head>` の末尾に出力するマークアップである。 */
interface DocumentOutput {
  readonly head: string;
}

/** 起動スクリプトに伝える要素を表す。`immediate` は、すぐ起動するインスタンスが 1 つでもあれば真である。 */
interface Delivered {
  readonly tag: string;
  readonly delivery: Delivery;
  readonly immediate: boolean;
}

/** 境界の差し替えを表す。 */
interface Patch {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  readonly html: Promise<string>;
  /** 差し替えの中身を出力する位置である。 */
  readonly out: Out;
}

/** `<Loading>` の境界と、シェルを表す。 */
interface Boundary {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  /** 境界の領域に出力する単位の列を表す。 */
  readonly region: Chunk[];
  /** 境界の中の `<slot>` に配置するスロットの内容を表す。内容に穴があれば、境界は保留中になる。 */
  readonly slotted: Chunk[][];
  readonly patches: Patch[];
  /** 境界を後送りにしたときに、中身を送るチャンクを表す。 */
  flush?: DeferredFlush;
}

/** 出力を送るチャンクを表す。シェルか、後送りの境界の中身である。 */
type Flush = ShellFlush | DeferredFlush;

/** チャンクがページに現れるかどうかを表す `shown` と、それを解決する `resolve` の組を表す。 */
interface Resolvable {
  /** チャンクを書き込んだら `true` に、書き込まないことが決まったら `false` に解決する。 */
  readonly shown: Promise<boolean>;
  readonly resolve: (shown: boolean) => void;
}

/** シェルを送るチャンクを表す。 */
interface ShellFlush extends Resolvable {
  readonly kind: "shell";
}

/** 後送りの境界の中身を送るチャンクを表す。 */
interface DeferredFlush extends Resolvable {
  readonly kind: "deferred";
  /** 中身の中で `notFound()` を受け止めたことを表す。 */
  noindex: boolean;
}

/** `source` の要素を、タグ名ごとに `target` に加える。同じタグなら、どちらかがすぐ起動するインスタンスを持つときに `immediate` を真にする。 */
function mergeDelivered(target: Map<string, Delivered>, source: Iterable<Delivered>): void {
  for (const delivered of source) {
    const current = target.get(delivered.tag);
    if (!current || (!current.immediate && delivered.immediate))
      target.set(delivered.tag, delivered);
  }
}

/** 解決していない `Resolvable` を作成する。 */
function resolvable(): Resolvable {
  const resolvers = Promise.withResolvers<boolean>();
  return { shown: resolvers.promise, resolve: resolvers.resolve };
}

/**
 * 出力の位置を表す。`flush` は、この位置の出力を送るチャンクである。
 * `shown` は、この位置の出力がページに現れたら `true` に、現れないことが決まったら `false` に解決する。
 * どの位置の `shown` も、外側の位置の `shown` より先には解決しない。
 * `shown` が `true` に解決する時点で、この位置の文字列化は終わっている。
 */
class Out {
  /** `Out` を、同じ形のオブジェクトと区別する。 */
  declare private readonly nominal: never;
  /** この位置の出力と同じ書き込みで、出力の後に書き込むスクリプトである。 */
  private readonly scripts: string[] = [];
  /** この位置に出力した、起動スクリプトに伝える要素を、タグ名ごとに表す。 */
  private readonly elements = new Map<string, Delivered>();

  /** 出力の後に書き込むスクリプトを加える。 */
  addScript(script: string): void {
    this.scripts.push(script);
  }

  /** 起動スクリプトに伝える要素を加える。 */
  addElement(delivered: Delivered): void {
    mergeDelivered(this.elements, [delivered]);
  }

  /** `other` の位置のスクリプトと要素を、この位置に加える。 */
  absorb(other: Out): void {
    this.scripts.push(...other.scripts);
    mergeDelivered(this.elements, other.elements.values());
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

/** 描画している位置の状態を表す。 */
interface WalkCtx {
  /** 要素の描画の範囲を表す owner である。要素の外では `null` である。 */
  readonly owner: Owner | null;
  /** この位置を含む Shadow DOM のホストを、外側から順に列挙する。 */
  readonly path: readonly HostRecord[];
  /** この位置を囲む境界を表す。 */
  readonly boundary: Boundary;
  /** 要素の Shadow DOM の中なら、`<slot>` の名前ごとに、その `<slot>` を囲む境界を記録する。 */
  readonly slots?: Map<string, Boundary>;
  /** 名前付きのスロットに配置する内容のうち、最上位のノードを描画しているときは、そのスロットの名前を表す。 */
  readonly slot?: string;
}

/** 要素のホストごとの状態を表す。 */
class HostRecord {
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
const hostIds = (path: readonly HostRecord[]): string[] => path.map((host) => host.id);

const isNodeList = (node: Node): node is readonly Node[] => Array.isArray(node);

const voidTags: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** HTML の属性の名前として使用できる文字列に一致する正規表現である。 */
const attributeName = /^[^\s"'>/=\p{Cc}]+$/u;

/**
 * 属性の出力の規則で、`value` を `name` の属性として出力する文字列を返す。`true` は値の無い属性にする。
 * 名前に属性の名前として使用できない文字があれば、エラーを投げる。
 */
function attribute(name: string, value: unknown): string {
  if (!attributeName.test(name)) {
    throw new Error(`属性の名前 ${JSON.stringify(name)} には、使用できない文字が含まれています。`);
  }
  const text = attributeValue(name, value);
  if (text === null) return "";
  return value === true && text === "" ? ` ${name}` : ` ${name}="${escapeAttribute(text)}"`;
}

/** 目印の開始と終了の HTML を返す。 */
const marker = (id: string, inner = ""): string =>
  `<template data-ob="${id}"></template>${inner}<!--/ob:${id}-->`;

/** サーバーの描画で、`ctx.host` の代わりに渡す値である。プロパティを参照すると、エラーを投げる。 */
const serverHost = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "サーバーで描画している間は、ctx.host を使用できません。onMount か effect の中で使用してください。",
      );
    },
  },
);

/**
 * 出力の単位の列に、穴があるかどうかを返す。`<Errored>` の領域と要素のホストの中は調べ、`<Loading>` の中とスロットの内容の中は調べない。属性が未解決のホストは、穴として扱う。
 */
function hasHole(chunks: readonly Chunk[]): boolean {
  return chunks.some((chunk) => {
    if (typeof chunk === "string") return false;
    switch (chunk.kind) {
      case "hole":
        return true;
      case "errored":
        return hasHole(chunk.errored.chunks);
      case "host":
        return chunk.host.attributes instanceof Promise || hasHole(chunk.host.chunks);
      case "fail":
      case "mark":
      case "slotted":
        return false;
    }
  });
}

/** `elements` を起動スクリプトに伝えるスクリプトを返す。要素が無ければ空の文字列を返す。 */
const announceScript = (elements: readonly Delivered[]): string =>
  listScript(elements.map(({ tag, delivery }) => [tag, delivery.module, delivery.load] as const));

/** `elements` のうち、すぐ起動するインスタンスがある要素の `modulepreload` を返す。 */
const preloadLinks = (elements: readonly Delivered[]): string =>
  elements
    .filter((delivered) => delivered.immediate)
    .map(({ delivery }) => `<link rel="modulepreload" href="${escapeAttribute(delivery.module)}">`)
    .join("");

/** サーバーで木を描画する。 */
class Renderer {
  private seq = 0;
  private readonly disposers: (() => void)[] = [];
  /** シェルの後に後送りの境界を出力する処理のうち、終わっていないものを保持する。 */
  private readonly pending = new Set<Promise<void>>();
  /** この描画で作成したすべてのホストを保持する。 */
  private readonly hosts = new Set<HostRecord>();
  /** ホストに値を送る処理のうち、終わっていないものを保持する。 */
  private readonly values = new Set<Promise<void>>();
  /** 要素を描画したか、`<Loading>` の中身を後送りにしたときに真になる。真になったページにだけ、起動スクリプトを出力する。 */
  private interactive = false;
  /** `noindex` の `<meta>` を出力したことを表す。 */
  private noindexSent = false;
  /** シェルを表す境界である。 */
  private readonly root = this.newBoundary("", []);
  /** シェルの最も外側の位置である。 */
  private readonly shellOut = Out.of({
    ...resolvable(),
    kind: "shell",
  } satisfies ShellFlush);
  /** 起動スクリプトに伝えた要素のタグ名を保持する。 */
  private readonly announcedTags = new Set<string>();
  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを表す。 */
  private caught = 200;
  /** `<head>` に移動するタグを囲む目印に含める、描画ごとの値である。 */
  private readonly nonce = crypto.randomUUID();

  /**
   * `write` は、出力する文字列を受け取る。`blocking` なら、すべての境界を待って、フォールバックと差し替えを出力しない。
   * `document` は、文書を出力する描画で渡す。文書を出力する描画では、シェルの中かつ要素の外の `<title>`、`<meta>`、`<link>` を `<head>` に移動する。
   */
  constructor(
    private readonly write: (text: string) => void,
    private readonly blocking: boolean,
    private readonly document?: DocumentOutput,
  ) {}

  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを返す。受け止めていなければ 200 を返す。 */
  get status(): number {
    return this.caught;
  }

  private newBoundary(id: string, path: readonly HostRecord[]): Boundary {
    return { id, path, region: [], slotted: [], patches: [] };
  }

  private chunks(node: Node, ctx: WalkCtx): Chunk[] {
    const out: Chunk[] = [];
    this.walk(node, ctx, out);
    return out;
  }

  private walk(node: Node, ctx: WalkCtx, out: Chunk[]): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      const text = escapeText(String(node));
      out.push(
        ctx.slot === undefined ? text : `<span slot="${escapeAttribute(ctx.slot)}">${text}</span>`,
      );
      return;
    }
    if (isNodeList(node)) {
      for (const item of node) this.walk(item, ctx, out);
      return;
    }
    if (typeof node === "function") {
      this.thunk(node, ctx, out);
      return;
    }
    switch (node.kind) {
      case "tag":
        this.tag(node.tag, node.props, node.key, ctx, out);
        return;
      case "loading": {
        const boundary = this.newBoundary(`b${++this.seq}`, ctx.path);
        this.walk(node.children, { ...ctx, boundary }, boundary.region);
        out.push({ kind: "mark", mark: boundary, fallback: () => this.chunks(node.fallback, ctx) });
        return;
      }
      case "errored":
        this.errored(node, ctx, out);
        return;
      case "component": {
        if (isElementComponent(node.fn)) {
          this.element(node.fn, node.props, node.key, ctx, out, node.child);
          return;
        }
        const result = node.fn(node.props);
        if (result instanceof Promise) {
          out.push(this.hole(result.then((value) => this.chunks(asNode(value), ctx))));
        } else {
          this.walk(asNode(result), ctx, out);
        }
      }
    }
  }

  /** 関数を呼び出した値を描画する。関数が未解決の値を参照すると、値が解決してから描画する穴にする。 */
  private thunk(fn: () => Node, ctx: WalkCtx, out: Chunk[]): void {
    const value = this.settle(ctx, fn);
    if (value instanceof Promise) {
      out.push(this.hole(value.then((resolved) => this.chunks(resolved, ctx))));
    } else {
      this.walk(value, ctx, out);
    }
  }

  /** `promise` の穴を作成する。描画を中断して穴を捨てたときも、`promise` の reject を処理する。 */
  private hole(promise: Promise<Chunk[]>): Hole {
    promise.catch(() => {});
    return { kind: "hole", hole: promise };
  }

  /** `props` の値を返す。関数は、追跡せずに呼び出して、戻り値を返す。`tracked` なら、追跡して呼び出す。 */
  private value(raw: unknown, ctx: WalkCtx, tracked: boolean): unknown {
    if (!isFunction(raw)) return raw;
    return tracked ? raw() : runWithOwner(ctx.owner, () => untrack(raw));
  }

  /** `compute` を追跡せずに呼び出した値を返す。未解決の値を参照したときは、追跡して呼び出した値が解決する Promise を返す。 */
  private settle<T>(ctx: WalkCtx, compute: (tracked: boolean) => T): T | Promise<T> {
    try {
      return runWithOwner(ctx.owner, () => untrack(() => compute(false)));
    } catch (error) {
      if (!(error instanceof NotReadyError)) throw error;
      const settled = runWithOwner(ctx.owner, () => resolve(() => compute(true)));
      settled.catch(() => {});
      return settled;
    }
  }

  private tag(
    tag: string,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
  ): void {
    if (this.document && documentTags.get(tag) === "head") {
      if (ctx.owner === null && ctx.boundary === this.root) {
        const { slot: _, ...unslotted } = ctx;
        const id = ++this.seq;
        out.push(this.headMarker(id, ""));
        this.nativeTag(tag, props, key, unslotted, out);
        out.push(this.headMarker(id, "/"));
        return;
      }
      if (tag !== "link" && import.meta.env?.DEV) {
        console.warn(
          `[rinka] <${tag}> は${ctx.owner === null ? " <Loading> の内側" : "要素の中"}にあるので、<head> に移動せずに、記述した位置に出力します。`,
        );
      }
    }
    this.nativeTag(tag, props, key, ctx, out);
  }

  /** `<head>` に移動するタグの前（`end` が空）と後（`end` が `/`）に置く目印である。 */
  private headMarker(id: number, end: "" | "/"): string {
    return `<!--${this.nonce}:${id}${end}-->`;
  }

  private nativeTag(
    tag: string,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
  ): void {
    const openTag = (tracked: boolean): string => {
      let attributes = "";
      for (const [name, raw] of Object.entries(tag === "form" ? formProps(props) : props)) {
        if (name === "children" || name === "ref") continue;
        if (name === "slot" && ctx.slot !== undefined) continue;
        if (isEventProp(name) && isFunction(raw)) continue;
        attributes += attribute(name, this.value(raw, ctx, tracked));
      }
      if (key !== undefined) attributes += attribute(tagAttributeName("key"), key);
      if (ctx.slot !== undefined) attributes += attribute("slot", ctx.slot);
      return `<${tag}${attributes}>`;
    };
    if (tag === "slot") {
      const name = this.value(props.name, ctx, false);
      ctx.slots?.set(typeof name === "string" ? name : "", ctx.boundary);
    }
    const open = this.settle(ctx, openTag);
    out.push(typeof open === "string" ? open : this.hole(open.then((text) => [text])));
    if (voidTags.has(tag)) return;
    const { slot: _, ...inner } = ctx;
    this.walk(asNode(props.children), inner, out);
    out.push(`</${tag}>`);
  }

  private errored(node: ErroredNode, ctx: WalkCtx, out: Chunk[]): void {
    let chunks: Chunk[] = [];
    try {
      this.walk(node.children, ctx, chunks);
    } catch (error) {
      chunks = [{ kind: "fail", fail: error }];
    }
    out.push({ kind: "errored", errored: { chunks, node, ctx } });
  }

  /**
   * 要素のホストを出力し、Shadow DOM の中身を DSD として出力してから、Light DOM の子を出力する。
   * `child` があれば、要素を作成した描画の範囲のホストに、`@c:キー` でこの要素のホストの ID を送る。
   */
  private element(
    component: ElementComponent<unknown>,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
    child?: ScopedChild,
  ): void {
    this.interactive = true;
    const { tag, options, delivery } = component[elementInfo];
    const load = loadAttributeValue(props);
    const delivered: Delivered | undefined =
      delivery && ctx.owner === null
        ? { tag, delivery, immediate: (load ?? delivery.load) === "load" }
        : undefined;
    const id = `h${++this.seq}`;
    const record = new HostRecord(id, tag);
    this.hosts.add(record);
    let announce: string | undefined;
    if (child?.data instanceof HostRecord && this.hosts.has(child.data)) {
      const creator = child.data;
      const mapKey = childKey(child.key);
      if (creator.listChild(mapKey)) {
        this.send(creator, mapKey, Promise.resolve(scriptJson(id)));
      } else {
        announce = dataScript(creator.id, mapKey, scriptJson(id));
      }
    }
    const slotNames = new Set(["children", ...(options.slots ?? [])]);
    const functionProps = new Set(options.functionProps);
    const descriptors = Object.getOwnPropertyDescriptors(props);
    const read = (name: string): unknown => {
      const descriptor = descriptors[name];
      const getter = descriptor?.get;
      return getter ? (getter.call(props) as unknown) : descriptor?.value;
    };
    /** 要素の関数に渡す値を返す。関数の props でない props に渡した関数は、呼び出した値にする。 */
    const propValue = (name: string): unknown => {
      const value = read(name);
      return isFunction(value) && !functionProps.has(name) ? value() : value;
    };

    const elementProps = {};
    for (const name of options.props) {
      if (slotNames.has(name)) continue;
      Object.defineProperty(elementProps, name, {
        enumerable: true,
        get: () =>
          propValue(name) ?? (functionProps.has(name) && isEventProp(name) ? () => {} : undefined),
      });
    }
    const hostAttributes = (tracked: boolean): HostAttributes => {
      let text = "";
      let transfer: Record<string, unknown> | undefined;
      for (const name of options.props) {
        if (slotNames.has(name)) continue;
        const value = propValue(name);
        if ((typeof value === "object" && value !== null) || typeof value === "function") {
          if (ctx.owner !== null) continue;
          checkSerializable(value, `<${tag}> ${name}`, true);
          (transfer ??= {})[name] = value;
          continue;
        }
        text += attribute(propToAttribute(name), value);
      }
      for (const name of Object.keys(descriptors)) {
        if (options.props.includes(name) || slotNames.has(name) || name === "ref") continue;
        if (reservedProp(name) === "load:" || (name === "slot" && ctx.slot !== undefined)) continue;
        const raw = read(name);
        if (isEventProp(name) && isFunction(raw)) continue;
        text += attribute(name, this.value(raw, ctx, tracked));
      }
      if (key !== undefined) text += attribute(tagAttributeName("key"), key);
      if (ctx.slot !== undefined) text += attribute("slot", ctx.slot);
      return { text, transfer };
    };
    const attributes = this.settle(ctx, hostAttributes);

    let owner: Owner | null = null;
    let tree: Node = null;
    const elementCtx: Ctx = {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      host: serverHost as HTMLElement,
      onMount: () => {},
      expose: () => {},
    };
    const scope = createScope(
      <T>(memoKey: string, fn: (prev: T | undefined) => T | PromiseLike<T>) =>
        createMemo<T>((prev) => {
          const result = fn(prev);
          if (isPromiseLike(result) && record.listMemo(memoKey)) {
            this.sendMemo(record, `<${tag}> の memo ${memoKey}`, memoKey, result);
          }
          return result;
        }),
      record,
    );
    createRoot((dispose) => {
      this.disposers.push(dispose);
      owner = getOwner();
      tree = asNode(untrack(() => withScope(scope, () => component(elementProps, elementCtx))));
    });

    const chunks: Chunk[] = [];
    const slots = new Map<string, Boundary>();
    this.walk(tree, { owner, path: [...ctx.path, record], boundary: ctx.boundary, slots }, chunks);
    chunks.push("</template>");
    for (const name of Object.keys(descriptors)) {
      if (!slotNames.has(name)) continue;
      const slot = name === "children" ? "" : name;
      const content = asNode(runWithOwner(ctx.owner, () => untrack(() => read(name))));
      const boundary = slots.get(slot) ?? ctx.boundary;
      const light: WalkCtx = {
        owner: ctx.owner,
        path: ctx.path,
        boundary,
        ...(ctx.slots && { slots: ctx.slots }),
        ...(slot !== "" && { slot }),
      };
      if (boundary === ctx.boundary) {
        this.walk(content, light, chunks);
      } else {
        const own = this.chunks(content, light);
        boundary.slotted.push(own);
        chunks.push({ kind: "slotted", slotted: { boundary, chunks: own, path: ctx.path } });
      }
    }
    chunks.push(`</${tag}>`);
    const open = ({ text, transfer }: HostAttributes, shown: Promise<boolean>): string => {
      const keys = record.seal(transfer ? [PROPS_KEY] : [], shown);
      const om = keys.length > 0 ? attribute("data-om", keys.join(" ")) : "";
      return `<${tag}${attribute("data-oh", id)}${attribute(loadAttributeName, load)}${text}${om}><template shadowrootmode="open">`;
    };
    out.push({ kind: "host", host: { record, attributes, open, chunks, announce, delivered } });
  }

  /**
   * 境界が保留中かどうかを返す。領域の中に穴があるか、境界の中の `<slot>` に配置するスロットの内容に穴があれば保留中である。
   * `blocking` では、常に偽を返す。
   */
  private isPending(boundary: Boundary): boolean {
    return !this.blocking && (hasHole(boundary.region) || boundary.slotted.some(hasHole));
  }

  /** 出力の単位の列を、穴の内容を待ってから、`out` の位置に出力する文字列にする。 */
  private async serialize(chunks: readonly Chunk[], out: Out): Promise<string> {
    const parts = await Promise.all(chunks.map((chunk) => this.serializeChunk(chunk, out)));
    return parts.join("");
  }

  /** 出力の単位を文字列にする。保留中の境界は、フォールバックを目印で囲んで出力し、中身を後送りにする。 */
  private async serializeChunk(chunk: Chunk, out: Out): Promise<string> {
    if (typeof chunk === "string") return chunk;
    switch (chunk.kind) {
      case "fail":
        throw chunk.fail;
      case "hole":
        return this.serialize(await chunk.hole, out);
      case "mark": {
        const boundary = chunk.mark;
        if (!this.isPending(boundary)) return this.serialize(boundary.region, out);
        this.schedule(boundary, out);
        return marker(boundary.id, await this.serialize(chunk.fallback(), out));
      }
      case "slotted": {
        const { boundary, chunks, path } = chunk.slotted;
        const { flush } = boundary;
        if (!flush || !hasHole(chunks)) return this.serialize(chunks, out);
        const id = `p${++this.seq}`;
        const into = out.into(flush);
        const html = this.serialize(chunks, into);
        html.catch(() => {});
        boundary.patches.push({ id, path, html, out: into });
        return marker(id);
      }
      case "host": {
        const { record, attributes, open, chunks, announce, delivered } = chunk.host;
        if (delivered) out.addElement(delivered);
        const inner = await this.serialize(chunks, out);
        const resolved = await attributes;
        if (resolved.transfer) {
          this.send(
            record,
            PROPS_KEY,
            Promise.resolve(toScript(resolved.transfer, `<${record.tag}>`)),
          );
        }
        if (announce) out.addScript(announce);
        return open(resolved, out.shown) + inner;
      }
      case "errored": {
        const { chunks, node, ctx } = chunk.errored;
        let failed = false;
        const kept = out.conditional(() => !failed);
        try {
          const html = await this.serialize(chunks, kept);
          out.absorb(kept);
          return html;
        } catch (error) {
          failed = true;
          const { flush } = out;
          const thrown = classify(error);
          switch (thrown.kind) {
            case "redirect":
              if (flush.kind === "shell" || thrown.safe) throw error;
              break;
            case "notFound":
              if (flush.kind === "shell") throw error;
              flush.noindex = true;
              break;
            case "response":
              if (flush.kind === "shell") throw error;
              break;
            case "error":
              if (flush.kind === "shell") this.caught = Math.max(this.caught, node.status ?? 500);
              break;
          }
          return this.serialize(this.chunks(node.fallback(error), ctx), out);
        }
      }
    }
  }

  /**
   * 境界の中身と差し替えを、目印の位置の出力がページに現れた後に出力する。
   * 中身の出力に失敗したときは、規則に合う移動先への移動なら移動させ、それ以外ならエラーを記録する。
   * 中身の出力に失敗したときと、目印の位置の出力がページに現れないときは、中身と差し替えを出力しない。
   */
  private schedule(boundary: Boundary, out: Out): void {
    this.interactive = true;
    const flush: DeferredFlush = {
      ...resolvable(),
      kind: "deferred",
      noindex: false,
    };
    boundary.flush = flush;
    for (const host of boundary.path) host.defer();
    this.track(
      (async () => {
        const regionOut = Out.of(flush);
        const content = this.serialize(boundary.region, regionOut);
        await content.catch(() => {});
        if (!(await out.shown)) {
          this.abandon(boundary, flush);
          return;
        }
        let region: string;
        let patches: [Patch, string][];
        try {
          region = await content;
          patches = await Promise.all(
            boundary.patches.map(async (patch): Promise<[Patch, string]> => [
              patch,
              await patch.html,
            ]),
          );
        } catch (error) {
          const thrown = classify(error);
          if (thrown.kind === "redirect" && thrown.safe) {
            this.write(
              `<script>location.replace(${scriptJson(thrown.location)})</script><meta http-equiv="refresh" content="0;url=${escapeAttribute(thrown.location)}">`,
            );
          } else {
            console.error(
              thrown.kind === "redirect"
                ? `[rinka] 移動先 ${JSON.stringify(thrown.location)} は、相対 URL でも http や https の URL でもないので、移動させずにフォールバックのまま残します。`
                : "[rinka] シェルを送った後に、<Loading> の中身の描画に失敗しました。フォールバックのまま残します。",
              error,
            );
          }
          this.abandon(boundary, flush);
          return;
        }
        const spec: SwapSpec = {
          b: boundary.id,
          bp: hostIds(boundary.path),
          p: patches.map(([patch]) => [patch.id, hostIds(patch.path)]),
        };
        let noindex = "";
        if (flush.noindex && !this.noindexSent) {
          this.noindexSent = true;
          noindex =
            '<meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script>';
        }
        this.reveal(
          flush,
          noindex +
            `<template data-os="${boundary.id}">${region}</template>` +
            patches
              .map(([patch, html]) => `<template data-op="${patch.id}">${html}</template>`)
              .join("") +
            this.tailOf([regionOut, ...patches.map(([patch]) => patch.out)]) +
            swapScript(spec),
        );
        this.finishBoundary(boundary);
      })(),
    );
  }

  /**
   * `promise` が解決した値を、シェルを出力した後に `$rinka.d` でホストに送る。
   * 失敗した値とシリアライズできない値の代わりに、値が無いことを表す `$rinka.n` を送る。シリアライズできない値は記録する。
   */
  private sendMemo(
    host: HostRecord,
    path: string,
    key: string,
    promise: PromiseLike<unknown>,
  ): void {
    this.send(
      host,
      key,
      (async () => {
        let resolved: unknown;
        try {
          resolved = await promise;
        } catch {
          return noValue;
        }
        try {
          return toScript(resolved, path);
        } catch (error) {
          console.error("[rinka] memo の値を送れないので、要素がブラウザで計算し直します。", error);
          return noValue;
        }
      })(),
    );
  }

  /**
   * `expression` が解決した JS の式を、ホストをページに出力した後に、`$rinka.d` でホストの `key` の値として送る。
   * 送るのは、開始タグの `data-om` に列挙したキーの値だけで、キーごとに 1 回だけ送る。ホストを出力しなければ送らない。
   */
  private send(host: HostRecord, key: string, expression: Promise<string>): void {
    const task = (async () => {
      const value = await expression;
      if (!(await host.take(key))) return;
      this.write(dataScript(host.id, key, value));
    })();
    this.values.add(task);
  }

  /** `flush` のチャンク `html` を書き込み、`flush` のチャンクがページに現れたことを決める。 */
  private reveal(flush: Flush, html: string): void {
    this.write(html);
    flush.resolve(true);
  }

  /** 境界の中身を出力しないことを決める。 */
  private abandon(boundary: Boundary, flush: DeferredFlush): void {
    flush.resolve(false);
    this.finishBoundary(boundary);
  }

  /** 境界を送り終えたものとして数え、Shadow DOM の中の後送りの境界をすべて送り終えたホストに、`@b` の値を送る。 */
  private finishBoundary(boundary: Boundary): void {
    for (const host of boundary.path) {
      if (host.release()) this.send(host, BOUNDARIES_KEY, Promise.resolve("1"));
    }
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    const done = () => {
      this.pending.delete(task);
    };
    task.then(done, done);
  }

  /** シェルの後の処理を、処理の中で加えた処理も含めて、すべて終わるまで待つ。 */
  private async drain(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.all(this.pending);
    return this.drain();
  }

  /** シェルを描画し、シェルの HTML を返す。 */
  async shell(node: Node): Promise<string> {
    return this.serialize(
      this.chunks(node, { owner: null, path: [], boundary: this.root }),
      this.shellOut,
    );
  }

  /** `outs` に出力した要素のうち、まだ起動スクリプトに伝えていない要素を、伝えたものとして記録して返す。 */
  private takeUnannounced(outs: readonly Out[]): Delivered[] {
    const merged = new Map<string, Delivered>();
    for (const out of outs) mergeDelivered(merged, out.delivered);
    const fresh = [...merged.values()].filter(({ tag }) => !this.announcedTags.has(tag));
    for (const { tag } of fresh) this.announcedTags.add(tag);
    return fresh;
  }

  /** `outs` のスクリプトと、まだ起動スクリプトに伝えていない要素を伝えるスクリプトを、連結して返す。 */
  private tailOf(outs: readonly Out[]): string {
    return (
      outs.map((position) => position.scriptText).join("") +
      announceScript(this.takeUnannounced(outs))
    );
  }

  /** シェルの文字列 `shell` から、目印で囲んだタグを取り除き、取り除いたタグを文書の順序で連結した文字列と、残りの文字列を返す。 */
  private takeHead(shell: string): { readonly tags: string; readonly body: string } {
    const tags: string[] = [];
    const inner = new RegExp(`<!--${this.nonce}:\\d+/?-->`, "g");
    const body = shell.replace(
      new RegExp(`<!--${this.nonce}:(\\d+)-->([\\s\\S]*?)<!--${this.nonce}:\\1/-->`, "g"),
      (_match, _id: string, tag: string) => {
        tags.push(tag.replace(inner, ""));
        return "";
      },
    );
    return { tags: tags.join(""), body };
  }

  /** 文書の先頭と `shell` を出力し、後送りの境界をすべて出力してから、文書を閉じる。 */
  async finish(shell: string): Promise<void> {
    try {
      const fresh = this.interactive ? this.takeUnannounced([this.shellOut]) : [];
      const script = this.interactive
        ? bootstrap + preloadLinks(fresh) + announceScript(fresh)
        : "";
      const { tags, body } = this.takeHead(shell);
      this.reveal(
        this.shellOut.flush,
        `<!doctype html><html><head><meta charset="utf-8">${tags}${script}${this.document?.head ?? ""}</head><body>${body}${this.shellOut.scriptText}`,
      );
      await this.drain();
      for (const host of this.hosts) host.hide();
      await Promise.all(this.values);
      this.write("</body></html>");
    } finally {
      this.dispose();
    }
  }

  /** 要素の描画の範囲を破棄する。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}

/** `value` が、`then` を持つ値かどうかを返す。 */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value && isFunction(value.then);

/** 描画のオプションを表す。 */
export interface RenderOptions {
  /** すべての `<Loading>` の中身を待ち、中身を埋め込んだ HTML を送る。 */
  readonly blocking?: boolean;
}

/** `node` を描画し、すべての非同期の内容を待ってから、`node` の HTML の文字列を返す。 */
export async function renderToString(node: unknown): Promise<string> {
  const renderer = new Renderer(() => {}, true);
  try {
    return await renderer.shell(asNode(node));
  } finally {
    renderer.dispose();
  }
}

/** `node` を、文書の全体の HTML のストリームとして描画する。シェルを送った後に、後送りの境界を届いた順に送る。 */
export function renderToStream(
  node: unknown,
  options: RenderOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const renderer = new Renderer(
        (text) => controller.enqueue(encoder.encode(text)),
        options.blocking ?? false,
        { head: "" },
      );
      try {
        await renderer.finish(await renderer.shell(asNode(node)));
        controller.close();
      } catch (error) {
        renderer.dispose();
        controller.error(error);
      }
    },
  });
}

/** レスポンスのオプションを表す。 */
export interface ResponseOptions extends RenderOptions {
  readonly headers?: Record<string, string>;
  /** シェルの中で `notFound()` を投げたときに、404 で返すページを返す。 */
  readonly notFound?: () => unknown;
  /** シェルの中で、どの `<Errored>` も受け止めなかったエラーを受け取り、500 で返すページを返す。 */
  readonly error?: (error: unknown) => unknown;
}

/**
 * `node` を描画し、シェルが揃った時点で、本文を送り続ける Response を返す。
 * シェルの中で投げた `redirect()` はリダイレクトのレスポンスにし、Response はそのまま返す。
 * `notFound()` は `notFound` のページを 404 で返し、ページが無ければ `Not Found` のテキストを 404 で返す。
 * どの `<Errored>` も受け止めなかったエラーは、`error` のページを 500 で返し、ページが無ければ reject する。
 * `notFound` のページの描画で投げたエラーには `error` のページを使用する。`error` のページの描画で投げた値は、ページを使用せずに、`redirect()` と `notFound()` と Response を同じ規則で扱い、それ以外では reject する。
 */
export function renderToResponse(node: unknown, options: ResponseOptions = {}): Promise<Response> {
  return respond(node, options, 200);
}

/** `<head>` に出力するマークアップを加えた、レスポンスのオプションを表す。 */
export interface DocumentOptions extends ResponseOptions {
  /** 文書の `<head>` の末尾に出力するマークアップである。 */
  readonly head?: string;
}

/** `renderToResponse` と同じ規則で、`options.head` を `<head>` の末尾に出力した Response を返す。 */
export function renderDocument(node: unknown, options: DocumentOptions): Promise<Response> {
  return respond(node, options, 200);
}

/** `node` を描画した Response を返す。ステータスは、`status` と、シェルの中の `<Errored>` が決めたステータスのうち大きいほうである。 */
async function respond(node: unknown, options: DocumentOptions, status: number): Promise<Response> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const renderer = new Renderer(
    (text) => controller.enqueue(encoder.encode(text)),
    options.blocking ?? false,
    { head: options.head ?? "" },
  );
  let shell: string;
  try {
    shell = await renderer.shell(asNode(node));
  } catch (error) {
    renderer.dispose();
    return failure(error, options);
  }
  renderer.finish(shell).then(
    () => controller.close(),
    (error: unknown) => controller.error(error),
  );
  return new Response(body, {
    status: Math.max(status, renderer.status),
    headers: { "content-type": "text/html; charset=utf-8", ...options.headers },
  });
}

/** シェルの中で投げられた値から、レスポンスを作成する。 */
function failure(error: unknown, options: DocumentOptions): Response | Promise<Response> {
  const thrown = classify(error);
  switch (thrown.kind) {
    case "redirect":
      return thrown.response;
    case "response":
      return thrown.response;
    case "notFound": {
      const page = options.notFound;
      return page
        ? respond(page(), { ...options, notFound: undefined }, 404)
        : new Response("Not Found", { status: 404 });
    }
    case "error": {
      const page = options.error;
      if (page)
        return respond(page(error), { ...options, notFound: undefined, error: undefined }, 500);
      throw error;
    }
  }
}
