import {
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
import { checkSerializable } from "../shared/wire.ts";
import { bootstrap } from "./bootstrap.ts";
import { asNode, type ErroredNode, type Node } from "./tree.ts";

/**
 * 出力の単位を表す。文字列、穴、`<Loading>` の位置、`<Errored>` の領域のいずれかである。
 * 穴は、描画した時点では内容が決まらず、値が解決してから内容が決まる位置である。
 * 後送りの境界は、シェルにはフォールバックを目印で囲んで出力し、中身はシェルの後に出力して、起動スクリプトが目印の間と差し替える。
 */
type Chunk = string | Hole | Mark | ErroredRegion;

/** 穴を表す。`hole` は、内容が決まると出力の単位の列に解決する。 */
interface Hole {
  readonly hole: Promise<Chunk[]>;
}

/** `<Loading>` の位置を表す。中身を埋め込むか、フォールバックを出力して後送りにするかは、文字列にする時点で決定する。 */
interface Mark {
  readonly mark: Boundary;
  readonly fallback: Chunk[];
}

/** `<Errored>` の領域を表す。中身の穴が失敗すると、`node.fallback` が返した内容を出力する。 */
interface ErroredRegion {
  readonly errored: { readonly chunks: Chunk[]; readonly node: ErroredNode; readonly ctx: WalkCtx };
}

/** 境界の中身と同時に出力する、境界の領域の外にある位置の差し替えを表す。 */
interface Patch {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  readonly chunks: Chunk[];
  /** 目印を出力する境界を表す。 */
  readonly sink: Boundary;
}

/** `<Loading>` の境界と、シェルを表す。 */
interface Boundary {
  readonly id: string;
  /** 目印を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  /** 境界の領域に出力する単位の列を表す。 */
  readonly region: Chunk[];
  readonly patches: Patch[];
  readonly parent: Boundary | null;
  /** 境界の中身を出力した時点で解決する。中身を埋め込んだ境界では、親の境界の Promise である。 */
  emitted: Promise<void>;
  markEmitted: () => void;
  /** 中身の出力に失敗したか、親の境界が失敗したので、この境界の中身と差し替えを出力していないことを表す。 */
  failed: boolean;
}

/** 描画している位置の状態を表す。 */
interface WalkCtx {
  /** 要素の描画の範囲を表す owner である。要素の外では `null` である。 */
  readonly owner: Owner | null;
  /** この位置を含む Shadow DOM のホストの ID を、外側から順に列挙する。 */
  readonly path: readonly string[];
  /** この位置の保留中の状態を受け止める境界を表す。 */
  readonly boundary: Boundary;
  /** この位置の出力を含む境界を表す。 */
  readonly sink: Boundary;
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

/** HTML の属性の名前に一致する正規表現である。 */
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

/** サーバーで木を描画する。 */
class Renderer {
  private seq = 0;
  private readonly disposers: (() => void)[] = [];
  /** シェルの後に後送りの境界を出力する処理のうち、終わっていないものを保持する。 */
  private readonly pending = new Set<Promise<void>>();
  /** シェルの外の境界を、作成した順に保持する。 */
  private readonly boundaries: Boundary[] = [];
  /** 要素を描画したか、`<Loading>` の中身を後送りにしたときに真になる。真のページにだけ、起動スクリプトを出力する。 */
  private interactive = false;

  /**
   * `write` は、出力する文字列を受け取る。`blocking` なら、すべての境界を待って、フォールバックと差し替えを出力しない。
   */
  constructor(
    private readonly write: (text: string) => void,
    private readonly blocking: boolean,
  ) {}

  private newBoundary(parent: Boundary | null, path: readonly string[]): Boundary {
    const { promise, resolve: markEmitted } = Promise.withResolvers<void>();
    const boundary: Boundary = {
      id: parent ? `b${++this.seq}` : "",
      path,
      region: [],
      patches: [],
      parent,
      emitted: promise,
      markEmitted,
      failed: false,
    };
    if (parent) this.boundaries.push(boundary);
    return boundary;
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
        this.walk(node.children, { ...ctx, boundary, sink: boundary }, boundary.region);
        out.push({ mark: boundary, fallback: this.chunks(node.fallback, ctx) });
        return;
      }
      case "errored":
        this.errored(node, ctx, out);
        return;
      case "component": {
        if (isElementComponent(node.fn)) {
          this.element(node.fn, node.props, node.key, ctx, out);
          return;
        }
        const result = node.fn(node.props);
        if (result instanceof Promise) {
          this.defer(
            [
              this.hole(
                result.then((value) => this.chunks(asNode(value), { ...ctx, sink: ctx.boundary })),
              ),
            ],
            ctx,
            out,
          );
        } else {
          this.walk(asNode(result), ctx, out);
        }
      }
    }
  }

  /** 関数を呼び出した値を描画する。関数が未解決の値を参照すると、値が解決してから描画する穴にする。 */
  private thunk(fn: () => Node, ctx: WalkCtx, out: Chunk[]): void {
    const value = this.settle(ctx, fn);
    if (!(value instanceof Promise)) {
      this.walk(value, ctx, out);
      return;
    }
    this.defer(
      [this.hole(value.then((resolved) => this.chunks(resolved, { ...ctx, sink: ctx.boundary })))],
      ctx,
      out,
    );
  }

  /** `promise` の穴を作成する。描画を中断して穴を捨てても、`promise` の reject は処理されないままにならない。 */
  private hole(promise: Promise<Chunk[]>): Hole {
    promise.catch(() => {});
    return { hole: promise };
  }

  /**
   * 保留中の値を含む出力の単位の列を出力する。この位置の出力が、保留中の状態を受け止める境界とは別の境界に属するときは、
   * 目印を出力し、境界に属する差し替えとして列を後から送る。`chunks` の中の位置の出力は、受け止める境界に属するものとして描画する。
   */
  private defer(chunks: Chunk[], ctx: WalkCtx, out: Chunk[]): void {
    if (this.blocking || ctx.boundary === ctx.sink) {
      out.push(...chunks);
      return;
    }
    const id = `p${++this.seq}`;
    out.push(`<template data-ob="${id}"></template><!--/ob:${id}-->`);
    ctx.boundary.patches.push({ id, path: ctx.path, chunks, sink: ctx.sink });
  }

  /** `props` の値を返す。関数は、追跡せずに呼び出して、戻り値を返す。`tracked` なら、追跡して呼び出す。 */
  private value(raw: unknown, ctx: WalkCtx, tracked: boolean): unknown {
    if (!isFunction(raw)) return raw;
    return tracked ? raw() : runWithOwner(ctx.owner, () => untrack(raw));
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
    const pending = typeof open !== "string";
    const own: Chunk[] = [pending ? this.hole(open.then((text) => [text])) : open];
    if (!voidTags.has(tag)) {
      const { slot: _, ...inner } = ctx;
      this.walk(asNode(props.children), pending ? { ...inner, sink: ctx.boundary } : inner, own);
      own.push(`</${tag}>`);
    }
    if (pending) this.defer(own, ctx, out);
    else out.push(...own);
  }

  /** `compute` を追跡せずに呼び出した値を返す。未解決の値を参照したときは、追跡して呼び出した値が解決する Promise を返す。 */
  private settle<T>(ctx: WalkCtx, compute: (tracked: boolean) => T): T | Promise<T> {
    try {
      return runWithOwner(ctx.owner, () => untrack(() => compute(false)));
    } catch (error) {
      if (!(error instanceof NotReadyError)) throw error;
      return runWithOwner(ctx.owner, () => resolve(() => compute(true)));
    }
  }

  private errored(node: ErroredNode, ctx: WalkCtx, out: Chunk[]): void {
    const chunks: Chunk[] = [];
    try {
      this.walk(node.children, ctx, chunks);
    } catch (error) {
      this.walk(node.fallback(error), ctx, out);
      return;
    }
    out.push({ errored: { chunks, node, ctx } });
  }

  /** 要素のホストを出力し、Shadow DOM の中身を DSD として出力してから、Light DOM の子を出力する。 */
  private element(
    component: ElementComponent<unknown>,
    props: Record<string, unknown>,
    key: string | undefined,
    ctx: WalkCtx,
    out: Chunk[],
  ): void {
    this.interactive = true;
    const { tag, options } = component[elementInfo];
    const id = `h${++this.seq}`;
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
    const hostAttributes = (tracked: boolean) => {
      let text = "";
      let transfer = false;
      for (const name of options.props) {
        if (slotNames.has(name)) continue;
        const value = propValue(name);
        if ((typeof value === "object" && value !== null) || typeof value === "function") {
          checkSerializable(value, `<${tag}> ${name}`);
          transfer = true;
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
    let waits: string[] = [];
    const open = ({ text, transfer }: { text: string; transfer: boolean }): string => {
      const keys = transfer ? [...waits, "@p"] : waits;
      const om = keys.length > 0 ? attribute("data-om", keys.join(" ")) : "";
      return `<${tag}${attribute("data-oh", id)}${text}${om}><template shadowrootmode="open">`;
    };
    const host = this.settle(ctx, hostAttributes);
    const pending = host instanceof Promise;
    const sink = pending ? ctx.boundary : ctx.sink;
    const own: Chunk[] = [pending ? this.hole(host.then((attributes) => [open(attributes)])) : ""];

    let owner: Owner | null = null;
    let tree: Node = null;
    const elementCtx: Ctx = {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      host: serverHost as HTMLElement,
      onMount: () => {},
      expose: () => {},
    };
    createRoot((dispose) => {
      this.disposers.push(dispose);
      owner = getOwner();
      tree = asNode(untrack(() => component(elementProps, elementCtx)));
    });

    const slots = new Map<string, Boundary>();
    this.walk(tree, { owner, path: [...ctx.path, id], boundary: ctx.boundary, sink, slots }, own);
    own.push("</template>");
    for (const name of Object.keys(descriptors)) {
      if (!slotNames.has(name)) continue;
      const slot = name === "children" ? "" : name;
      const light: WalkCtx = {
        owner: ctx.owner,
        path: ctx.path,
        boundary: slots.get(slot) ?? ctx.boundary,
        sink,
      };
      const content = asNode(runWithOwner(ctx.owner, () => untrack(() => read(name))));
      this.walk(content, slot === "" ? light : { ...light, slot }, own);
    }
    own.push(`</${tag}>`);
    waits = this.boundaries
      .filter(
        (boundary) =>
          this.isPending(boundary) &&
          (boundary.path.includes(id) || boundary.patches.some((patch) => patch.path.includes(id))),
      )
      .map((boundary) => `@${boundary.id}`);
    if (pending) {
      this.defer(own, ctx, out);
    } else {
      own[0] = open(host);
      out.push(...own);
    }
  }

  /**
   * 境界が保留中かどうかを返す。領域の中（`<Errored>` の領域の中を含む）に穴があるか、境界に属する差し替えがあれば保留中である。
   * `blocking` では、常に偽を返す。
   */
  private isPending(boundary: Boundary): boolean {
    const hasHole = (chunks: Chunk[]): boolean =>
      chunks.some(
        (chunk) =>
          typeof chunk !== "string" &&
          ("hole" in chunk || ("errored" in chunk && hasHole(chunk.errored.chunks))),
      );
    return !this.blocking && (hasHole(boundary.region) || boundary.patches.length > 0);
  }

  /** 出力の単位の列を、穴の内容を待ってから文字列にする。 */
  private async serialize(chunks: Chunk[], parent: Boundary): Promise<string> {
    const parts = await Promise.all(chunks.map((chunk) => this.serializeChunk(chunk, parent)));
    return parts.join("");
  }

  /** 出力の単位を文字列にする。保留中の境界は、フォールバックを目印で囲んで出力し、中身を後送りにする。 */
  private async serializeChunk(chunk: Chunk, parent: Boundary): Promise<string> {
    if (typeof chunk === "string") return chunk;
    if ("hole" in chunk) return this.serialize(await chunk.hole, parent);
    if ("mark" in chunk) {
      const boundary = chunk.mark;
      if (!this.isPending(boundary)) {
        boundary.emitted = parent.emitted;
        return this.serialize(boundary.region, boundary);
      }
      this.schedule(boundary);
      const fallback = await this.serialize(chunk.fallback, parent);
      return `<template data-ob="${boundary.id}"></template>${fallback}<!--/ob:${boundary.id}-->`;
    }
    const { chunks, node, ctx } = chunk.errored;
    try {
      return await this.serialize(chunks, parent);
    } catch (error) {
      return this.serialize(this.chunks(node.fallback(error), ctx), parent);
    }
  }

  /**
   * 境界の中身と、境界に属する差し替えを出力する。出力するのは、親の境界と、差し替えの目印を含む境界を、すべて出力した後である。
   * 中身か親の境界の出力に失敗したら、中身と差し替えを出力しない。
   */
  private schedule(boundary: Boundary): void {
    const parent = boundary.parent;
    if (!parent) return;
    this.interactive = true;
    this.track(
      (async () => {
        let region: string;
        let patches: { readonly patch: Patch; readonly html: string }[];
        try {
          region = await this.serialize(boundary.region, boundary);
          patches = await Promise.all(
            boundary.patches.map(async (patch) => ({
              patch,
              html: await this.serialize(patch.chunks, boundary),
            })),
          );
        } catch (error) {
          await parent.emitted;
          boundary.failed = true;
          boundary.markEmitted();
          console.error(
            "[rinka] シェルを送った後に、<Loading> の中身の描画に失敗しました。フォールバックのまま残します。",
            error,
          );
          return;
        }
        await parent.emitted;
        await Promise.all(boundary.patches.map((patch) => patch.sink.emitted));
        if (parent.failed) {
          boundary.failed = true;
          boundary.markEmitted();
          return;
        }
        const applied = patches.filter(({ patch }) => !patch.sink.failed);
        const hosts = [
          ...new Set([...boundary.path, ...boundary.patches.flatMap((patch) => patch.path)]),
        ];
        const spec = {
          b: boundary.id,
          bp: boundary.path,
          p: applied.map(({ patch }) => [patch.id, patch.path]),
          h: hosts,
        };
        this.write(
          `<template data-os="${boundary.id}">${region}</template>` +
            applied
              .map(({ patch, html }) => `<template data-op="${patch.id}">${html}</template>`)
              .join("") +
            `<script>$rinka.r(${JSON.stringify(spec)})</script>`,
        );
        boundary.markEmitted();
      })(),
    );
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

  /** `node` の HTML を返す。`document` なら、文書の全体を出力し、シェルの後の処理が終わるまで待つ。 */
  async run(node: Node, document: boolean): Promise<string> {
    const shell = this.newBoundary(null, []);
    try {
      const html = await this.serialize(
        this.chunks(node, { owner: null, path: [], boundary: shell, sink: shell }),
        shell,
      );
      if (!document) return html;
      const script = this.interactive ? bootstrap : "";
      this.write(`<!doctype html><html><head><meta charset="utf-8">${script}</head><body>${html}`);
      shell.markEmitted();
      await this.drain();
      this.write("</body></html>");
      return html;
    } finally {
      for (const dispose of this.disposers) dispose();
    }
  }
}

/** 描画のオプションを表す。 */
export interface RenderOptions {
  /** すべての `<Loading>` の解決を待ち、フォールバックと差し替えのスクリプトを含まない HTML を送る。 */
  readonly blocking?: boolean;
}

/** `node` を描画し、すべての非同期の内容を待ってから、HTML の文字列を返す。文書の全体は出力しない。 */
export function renderToString(node: unknown): Promise<string> {
  return new Renderer(() => {}, true).run(asNode(node), false);
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
        await renderer.run(asNode(node), true);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** レスポンスのオプションを表す。 */
export interface ResponseOptions extends RenderOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

/** `node` を描画し、シェルが揃った時点で、本文を送り続ける Response を返す。 */
export function renderToResponse(node: unknown, options: ResponseOptions = {}): Promise<Response> {
  const { promise, resolve: respond, reject } = Promise.withResolvers<Response>();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  let started = false;
  const renderer = new Renderer((text) => {
    if (!started) {
      started = true;
      respond(
        new Response(body, {
          status: options.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8", ...options.headers },
        }),
      );
    }
    controller.enqueue(encoder.encode(text));
  }, options.blocking ?? false);
  renderer.run(asNode(node), true).then(
    () => controller.close(),
    (error: unknown) => {
      if (started) controller.error(error);
      else reject(error);
    },
  );
  return promise;
}
