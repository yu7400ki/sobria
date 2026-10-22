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
  type ElementComponent,
} from "../shared/element.ts";
import { isEventProp, propToAttribute } from "../shared/names.ts";
import { isFunction } from "../shared/objects.ts";
import { createScope, withScope, type MemoScope, type ScopedChild } from "../shared/scope.ts";
import { checkSerializable } from "../shared/wire.ts";
import { bootstrap } from "./bootstrap.ts";
import { classify, type Thrown } from "./errors.ts";
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
    /** 目印を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
    readonly path: readonly string[];
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
    readonly id: string;
    readonly tag: string;
    readonly attributes: HostAttributes | Promise<HostAttributes>;
    readonly open: (attributes: HostAttributes, waiting: boolean) => string;
    readonly chunks: Chunk[];
  };
}

/** `<Errored>` の領域が、フォールバックに切り替わったかどうかを表す。 */
interface Region {
  discarded: boolean;
}

/** 境界の差し替えを表す。 */
interface Patch {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  readonly html: Promise<string>;
}

/** `<Loading>` の境界と、シェルを表す。 */
interface Boundary {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  /** 境界の領域に出力する単位の列を表す。 */
  readonly region: Chunk[];
  /** 境界の中の `<slot>` に配置するスロットの内容を表す。内容に穴があれば、境界は保留中になる。 */
  readonly slotted: Chunk[][];
  readonly patches: Patch[];
  readonly parent: Boundary | null;
  /** 中身を出力したら `true` に、出力しないことが決まったら `false` に解決する。中身を埋め込んだ境界では、親の境界の Promise である。 */
  sent: Promise<boolean>;
  send: (sent: boolean) => void;
  /** 目印を囲む `<Errored>` の領域を表す。 */
  regions: readonly Region[];
  /** シェルの後に出力する境界であることを表す。 */
  late: boolean;
  /** 境界の中で `notFound()` を受け止めたことを表す。 */
  noindex: boolean;
}

/** 描画している位置の状態を表す。 */
interface WalkCtx {
  /** 要素の描画の範囲を表す owner である。要素の外では `null` である。 */
  readonly owner: Owner | null;
  /** この位置を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  /** この位置を囲む境界を表す。 */
  readonly boundary: Boundary;
  /** 要素の Shadow DOM の中なら、`<slot>` の名前ごとに、その `<slot>` を囲む境界を記録する。 */
  readonly slots?: Map<string, Boundary>;
  /** 名前付きのスロットに配置する内容のうち、最上位のノードを描画しているときは、そのスロットの名前を表す。 */
  readonly slot?: string;
}

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

/** `value` を、`<script>` の中に埋め込める JSON にする。 */
const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

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

/** サーバーで木を描画する。 */
class Renderer {
  private seq = 0;
  private readonly disposers: (() => void)[] = [];
  /** シェルの後に後送りの境界を出力する処理のうち、終わっていないものを保持する。 */
  private readonly pending = new Set<Promise<void>>();
  /** ホストの ID ごとに、Shadow DOM の中で後送りにして、まだ送り終えていない境界の数を保持する。 */
  private readonly deferred = new Map<string, number>();
  /** 要素の描画の範囲ごとに、範囲を作成したホストの ID と、子要素のホストの ID を送るキーの列を保持する。 */
  private readonly scopeHosts = new WeakMap<
    MemoScope,
    { readonly id: string; readonly childKeys: string[] }
  >();
  /** ホストの ID ごとに、ホストをページに出力したら `true` に、出力しないことが決まったら `false` に解決する Promise を保持する。 */
  private readonly shown = new Map<string, PromiseWithResolvers<boolean>>();
  /** ホストに値を送る処理のうち、終わっていないものを保持する。 */
  private readonly values = new Set<Promise<void>>();
  /** 要素を描画したか、`<Loading>` の中身を後送りにしたときに真になる。真になったページにだけ、起動スクリプトを出力する。 */
  private interactive = false;
  /** `noindex` の `<meta>` を出力したことを表す。 */
  private noindexSent = false;
  /** シェルを表す境界である。 */
  private readonly root = this.newBoundary(null, []);
  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを表す。 */
  private caught = 200;

  /**
   * `write` は、出力する文字列を受け取る。`blocking` なら、すべての境界を待って、フォールバックと差し替えを出力しない。
   */
  constructor(
    private readonly write: (text: string) => void,
    private readonly blocking: boolean,
  ) {}

  /** シェルの中の `<Errored>` が受け止めたときのステータスのうち、最も大きいものを返す。受け止めていなければ 200 を返す。 */
  get status(): number {
    return this.caught;
  }

  private newBoundary(parent: Boundary | null, path: readonly string[]): Boundary {
    const { promise, resolve: send } = Promise.withResolvers<boolean>();
    return {
      id: parent ? `b${++this.seq}` : "",
      path,
      region: [],
      slotted: [],
      patches: [],
      parent,
      sent: promise,
      send,
      regions: [],
      late: false,
      noindex: false,
    };
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
        const boundary = this.newBoundary(ctx.boundary, ctx.path);
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
    const openTag = (tracked: boolean): string => {
      let attributes = "";
      for (const [name, raw] of Object.entries(props)) {
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
    const { tag, options } = component[elementInfo];
    const id = `h${++this.seq}`;
    const creator = child && this.scopeHosts.get(child.scope);
    if (child && creator) {
      const mapKey = `@c:${child.key}`;
      creator.childKeys.push(mapKey);
      this.send(creator.id, mapKey, Promise.resolve(scriptJson(id)));
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
          checkSerializable(value, `<${tag}> ${name}`);
          (transfer ??= {})[name] = value;
          continue;
        }
        text += attribute(propToAttribute(name), value);
      }
      for (const name of Object.keys(descriptors)) {
        if (options.props.includes(name) || slotNames.has(name) || name === "ref") continue;
        if (name.startsWith("load:") || (name === "slot" && ctx.slot !== undefined)) continue;
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
    const memoKeys: string[] = [];
    const scope = createScope(
      <T>(memoKey: string, fn: (prev: T | undefined) => T | PromiseLike<T>) =>
        createMemo<T>((prev) => {
          const result = fn(prev);
          if (isPromiseLike(result) && !memoKeys.includes(memoKey)) {
            memoKeys.push(memoKey);
            this.sendMemo(id, `<${tag}> の memo ${memoKey}`, memoKey, result);
          }
          return result;
        }),
    );
    const childKeys: string[] = [];
    this.scopeHosts.set(scope, { id, childKeys });
    createRoot((dispose) => {
      this.disposers.push(dispose);
      owner = getOwner();
      tree = asNode(untrack(() => withScope(scope, () => component(elementProps, elementCtx))));
    });

    const chunks: Chunk[] = [];
    const slots = new Map<string, Boundary>();
    this.walk(tree, { owner, path: [...ctx.path, id], boundary: ctx.boundary, slots }, chunks);
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
    const open = ({ text, transfer }: HostAttributes, waiting: boolean): string => {
      const keys = [
        ...memoKeys,
        ...childKeys,
        ...(waiting ? ["@b"] : []),
        ...(transfer ? ["@p"] : []),
      ];
      const om = keys.length > 0 ? attribute("data-om", keys.join(" ")) : "";
      return `<${tag}${attribute("data-oh", id)}${text}${om}><template shadowrootmode="open">`;
    };
    out.push({ kind: "host", host: { id, tag, attributes, open, chunks } });
  }

  /**
   * 境界が保留中かどうかを返す。領域の中に穴があるか、境界の中の `<slot>` に配置するスロットの内容に穴があれば保留中である。
   * `blocking` では、常に偽を返す。
   */
  private isPending(boundary: Boundary): boolean {
    return !this.blocking && (hasHole(boundary.region) || boundary.slotted.some(hasHole));
  }

  /** 出力の単位の列を、穴の内容を待ってから文字列にする。`regions` は、列を囲む `<Errored>` の領域である。 */
  private async serialize(
    chunks: readonly Chunk[],
    parent: Boundary,
    regions: readonly Region[],
  ): Promise<string> {
    const parts = await Promise.all(
      chunks.map((chunk) => this.serializeChunk(chunk, parent, regions)),
    );
    return parts.join("");
  }

  /** 出力の単位を文字列にする。保留中の境界は、フォールバックを目印で囲んで出力し、中身を後送りにする。 */
  private async serializeChunk(
    chunk: Chunk,
    parent: Boundary,
    regions: readonly Region[],
  ): Promise<string> {
    if (typeof chunk === "string") return chunk;
    switch (chunk.kind) {
      case "fail":
        throw chunk.fail;
      case "hole":
        return this.serialize(await chunk.hole, parent, regions);
      case "mark": {
        const boundary = chunk.mark;
        boundary.regions = regions;
        if (!this.isPending(boundary)) {
          boundary.sent = parent.sent;
          return this.serialize(boundary.region, boundary, regions);
        }
        this.schedule(boundary);
        return marker(boundary.id, await this.serialize(chunk.fallback(), parent, regions));
      }
      case "slotted": {
        const { boundary, chunks, path } = chunk.slotted;
        if (!boundary.late || !hasHole(chunks)) return this.serialize(chunks, parent, regions);
        const id = `p${++this.seq}`;
        const html = this.serialize(chunks, boundary, regions);
        html.catch(() => {});
        boundary.patches.push({ id, path, html });
        return marker(id);
      }
      case "host": {
        const { id, tag, attributes, open, chunks } = chunk.host;
        const inner = await this.serialize(chunks, parent, regions);
        const resolved = await attributes;
        if (resolved.transfer) {
          this.send(id, "@p", Promise.resolve(toScript(resolved.transfer, `<${tag}>`)));
        }
        const { sent } = parent;
        void sent.then((output) =>
          this.host(id).resolve(output && !regions.some((r) => r.discarded)),
        );
        return open(resolved, (this.deferred.get(id) ?? 0) > 0) + inner;
      }
      case "errored": {
        const { chunks, node, ctx } = chunk.errored;
        const region: Region = { discarded: false };
        try {
          return await this.serialize(chunks, parent, [...regions, region]);
        } catch (error) {
          const late = lateBoundary(parent);
          const thrown = classify(error);
          if (passesErrored(thrown, late !== undefined)) throw error;
          region.discarded = true;
          if (!late) this.caught = Math.max(this.caught, node.status ?? 500);
          else if (thrown.kind === "notFound") late.noindex = true;
          return this.serialize(this.chunks(node.fallback(error), ctx), parent, regions);
        }
      }
    }
  }

  /**
   * 境界の中身と差し替えを、親の境界を出力した後に出力する。
   * 中身の出力に失敗したときは、規則に合う移動先への移動なら移動させ、それ以外ならエラーを記録する。
   * 中身の出力に失敗したとき、親の境界を出力しないとき、目印を囲む `<Errored>` がフォールバックに切り替わったときは、中身と差し替えを出力しない。
   */
  private schedule(boundary: Boundary): void {
    const parent = boundary.parent;
    if (!parent) return;
    this.interactive = true;
    boundary.late = true;
    for (const host of boundary.path) this.deferred.set(host, (this.deferred.get(host) ?? 0) + 1);
    this.track(
      (async () => {
        let region: string;
        let patches: [Patch, string][];
        try {
          region = await this.serialize(boundary.region, boundary, []);
          if (!(await parent.sent) || boundary.regions.some((r) => r.discarded)) {
            this.abandon(boundary);
            return;
          }
          patches = await Promise.all(
            boundary.patches.map(async (patch): Promise<[Patch, string]> => [
              patch,
              await patch.html,
            ]),
          );
        } catch (error) {
          if (!(await parent.sent) || boundary.regions.some((r) => r.discarded)) {
            this.abandon(boundary);
            return;
          }
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
          this.abandon(boundary);
          return;
        }
        const spec = {
          b: boundary.id,
          bp: boundary.path,
          p: patches.map(([patch]) => [patch.id, patch.path]),
        };
        let noindex = "";
        if (boundary.noindex && !this.noindexSent) {
          this.noindexSent = true;
          noindex =
            '<meta name="robots" content="noindex"><script>document.head.append(document.currentScript.previousSibling.cloneNode())</script>';
        }
        this.write(
          noindex +
            `<template data-os="${boundary.id}">${region}</template>` +
            patches
              .map(([patch, html]) => `<template data-op="${patch.id}">${html}</template>`)
              .join("") +
            `<script>$rinka.r(${scriptJson(spec)})</script>`,
        );
        this.finishBoundary(boundary);
        boundary.send(true);
      })(),
    );
  }

  /**
   * `promise` が解決した値を、シェルを出力した後に `$rinka.d` でホストに送る。
   * 失敗した値とシリアライズできない値の代わりに、値が無いことを表す `$rinka.n` を送る。シリアライズできない値は記録する。
   */
  private sendMemo(host: string, path: string, key: string, promise: PromiseLike<unknown>): void {
    this.send(
      host,
      key,
      (async () => {
        let resolved: unknown;
        try {
          resolved = await promise;
        } catch {
          return "$rinka.n";
        }
        try {
          return toScript(resolved, path);
        } catch (error) {
          console.error("[rinka] memo の値を送れないので、要素がブラウザで計算し直します。", error);
          return "$rinka.n";
        }
      })(),
    );
  }

  /** ホストの ID が `id` のホストについて、ページに出力したかどうかを解決する `PromiseWithResolvers` を返す。 */
  private host(id: string): PromiseWithResolvers<boolean> {
    let shown = this.shown.get(id);
    if (!shown) this.shown.set(id, (shown = Promise.withResolvers<boolean>()));
    return shown;
  }

  /** `expression` が解決した JS の式を、ホストをページに出力した後に、`$rinka.d` でホストの `key` の値として送る。ホストを出力しなければ送らない。 */
  private send(host: string, key: string, expression: Promise<string>): void {
    const shown = this.host(host).promise;
    const task = (async () => {
      const value = await expression;
      if (!(await shown)) return;
      this.write(`<script>$rinka.d(${scriptJson(host)},{${scriptJson(key)}:${value}})</script>`);
    })();
    this.values.add(task);
  }

  /** 境界の中身を出力しないことを決める。 */
  private abandon(boundary: Boundary): void {
    this.finishBoundary(boundary);
    boundary.send(false);
  }

  /** 境界を送り終えたものとして数え、Shadow DOM の中の後送りの境界をすべて送り終えたホストに、`@b` の値を送る。 */
  private finishBoundary(boundary: Boundary): void {
    for (const host of boundary.path) {
      const rest = (this.deferred.get(host) ?? 0) - 1;
      this.deferred.set(host, rest);
      if (rest === 0) this.write(`<script>$rinka.d(${scriptJson(host)},{"@b":1})</script>`);
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
      this.root,
      [],
    );
  }

  /** 文書の先頭と `shell` を出力し、後送りの境界をすべて出力してから、文書を閉じる。 */
  async finish(shell: string): Promise<void> {
    try {
      const script = this.interactive ? bootstrap : "";
      this.write(`<!doctype html><html><head><meta charset="utf-8">${script}</head><body>${shell}`);
      this.root.send(true);
      await this.drain();
      for (const shown of this.shown.values()) shown.resolve(false);
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

/** 境界と、その祖先のうち、シェルの後に出力する最も内側の境界を返す。 */
function lateBoundary(boundary: Boundary): Boundary | undefined {
  for (let current: Boundary | null = boundary; current; current = current.parent) {
    if (current.late) return current;
  }
  return undefined;
}

/** `value` が、`then` を持つ値かどうかを返す。 */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value && isFunction(value.then);

/** `<Errored>` が受け止めずに通過させる値かどうかを返す。`late` は、シェルの後に出力する位置かどうかである。シェルの後では、規則に合う移動先への移動だけを通過させる。 */
function passesErrored(thrown: Thrown, late: boolean): boolean {
  switch (thrown.kind) {
    case "redirect":
      return !late || thrown.safe;
    case "notFound":
    case "response":
      return !late;
    case "error":
      return false;
  }
}

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
 * `notFound()` は `notFound` のページを 404 で返し、ページが無ければ本文の無い 404 を返す。
 * どの `<Errored>` も受け止めなかったエラーは、`error` のページを 500 で返し、ページが無ければ reject する。
 * `notFound` のページの描画で投げたエラーには `error` のページを使用する。`error` のページの描画で投げた値は、ページを使用せずに、`redirect()` と `notFound()` と Response を同じ規則で扱い、それ以外では reject する。
 */
export function renderToResponse(node: unknown, options: ResponseOptions = {}): Promise<Response> {
  return respond(node, options, 200);
}

/** `node` を描画した Response を返す。ステータスは、`status` と、シェルの中の `<Errored>` が決めたステータスのうち大きいほうである。 */
async function respond(node: unknown, options: ResponseOptions, status: number): Promise<Response> {
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
function failure(error: unknown, options: ResponseOptions): Response | Promise<Response> {
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
        : new Response(null, { status: 404 });
    }
    case "error": {
      const page = options.error;
      if (page)
        return respond(page(error), { ...options, notFound: undefined, error: undefined }, 500);
      throw error;
    }
  }
}
