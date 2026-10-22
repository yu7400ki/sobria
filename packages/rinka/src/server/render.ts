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
import { asNode, type ErroredNode, type Node } from "./tree.ts";

/** 出力の単位を表す。文字列、後から内容が決まる穴、`<Errored>` の領域のいずれかである。 */
type Chunk = string | Hole | ErroredRegion;

/** 内容が決まると、出力の単位の列に解決する Promise を表す。 */
interface Hole {
  readonly hole: Promise<Chunk[]>;
}

/** `<Errored>` の領域を表す。中身の穴が失敗すると、`fallback` を出力する。 */
interface ErroredRegion {
  readonly errored: { readonly chunks: Chunk[]; readonly node: ErroredNode; readonly ctx: WalkCtx };
}

/** 描画している位置の状態を表す。 */
interface WalkCtx {
  /** 要素の描画の範囲の owner。要素の外では `null` である。 */
  readonly owner: Owner | null;
  /** この位置を Shadow DOM の中に持つホストの ID の列。 */
  readonly path: readonly string[];
  /** 名前付きのスロットに配置する内容の最上位なら、そのスロットの名前。 */
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

/** 属性の出力の規則で、`value` を `name` の属性として出力する文字列を返す。`true` は値の無い属性にする。 */
function attribute(name: string, value: unknown): string {
  const text = attributeValue(name, value);
  if (text === null) return "";
  return value === true && text === "" ? ` ${name}` : ` ${name}="${escapeAttribute(text)}"`;
}

/** サーバーの描画で、`ctx.host` の代わりに渡す値。プロパティを参照すると、エラーを投げる。 */
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

  /** `node` を描画した、出力の単位の列を返す。 */
  chunks(node: Node, ctx: WalkCtx): Chunk[] {
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
      case "loading":
        this.walk(node.children, ctx, out);
        return;
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
          this.hole(
            result.then((value) => this.chunks(asNode(value), ctx)),
            out,
          );
        } else {
          this.walk(asNode(result), ctx, out);
        }
      }
    }
  }

  /** 関数を呼び出した値を描画する。未解決の値を読むと、値が解決してから描画する穴にする。 */
  private thunk(fn: () => Node, ctx: WalkCtx, out: Chunk[]): void {
    let value: Node;
    try {
      value = runWithOwner(ctx.owner, () => untrack(fn));
    } catch (error) {
      if (!(error instanceof NotReadyError)) throw error;
      const settled = runWithOwner(ctx.owner, () => resolve(fn));
      this.hole(
        settled.then((resolved) => this.chunks(resolved, ctx)),
        out,
      );
      return;
    }
    this.walk(value, ctx, out);
  }

  private hole(promise: Promise<Chunk[]>, out: Chunk[]): void {
    out.push({ hole: promise });
  }

  /** `props` の値を読み取る。関数は、追跡せずに呼び出した値にする。`tracked` なら追跡したまま呼び出す。 */
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
    const open = (tracked: boolean): string => {
      let attributes = "";
      for (const [name, raw] of Object.entries(props)) {
        if (name === "children" || name === "ref") continue;
        if (isEventProp(name) && typeof raw === "function") continue;
        attributes += attribute(name, this.value(raw, ctx, tracked));
      }
      if (key !== undefined) attributes += attribute(tagAttributeName("key"), key);
      if (ctx.slot !== undefined) attributes += attribute("slot", ctx.slot);
      return `<${tag}${attributes}>`;
    };
    try {
      out.push(open(false));
    } catch (error) {
      if (!(error instanceof NotReadyError)) throw error;
      const settled = runWithOwner(ctx.owner, () => resolve(() => open(true)));
      this.hole(
        settled.then((text) => [text]),
        out,
      );
    }
    if (voidTags.has(tag)) return;
    this.walk(asNode(props.children), { owner: ctx.owner, path: ctx.path }, out);
    out.push(`</${tag}>`);
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
    const { tag, options } = component[elementInfo];
    const id = `h${++this.seq}`;
    const slotNames = new Set(["children", ...(options.slots ?? [])]);
    const descriptors = Object.getOwnPropertyDescriptors(props);
    const read = (name: string): unknown => {
      const descriptor = descriptors[name];
      const getter = descriptor?.get;
      if (!getter) return descriptor?.value;
      return runWithOwner(ctx.owner, () => untrack(() => getter.call(props) as unknown));
    };

    let attributes = attribute("data-oh", id);
    let transferred: Record<string, unknown> | undefined;
    const elementProps = {};
    for (const name of options.props) {
      if (slotNames.has(name)) continue;
      Object.defineProperty(elementProps, name, {
        enumerable: true,
        get: () => read(name) ?? (isEventProp(name) ? () => {} : undefined),
      });
      const value = read(name);
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        checkSerializable(value, `<${tag}> ${name}`);
        (transferred ??= {})[name] = value;
        continue;
      }
      attributes += attribute(propToAttribute(name), value);
    }
    for (const name of Object.keys(descriptors)) {
      if (options.props.includes(name) || slotNames.has(name) || name === "ref") continue;
      if (name.startsWith("load:")) continue;
      const value = this.value(read(name), ctx, false);
      if (isEventProp(name) && typeof value === "function") continue;
      attributes += attribute(name, value);
    }
    if (key !== undefined) attributes += attribute(tagAttributeName("key"), key);
    if (ctx.slot !== undefined) attributes += attribute("slot", ctx.slot);

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

    const openIndex = out.push("") - 1;
    this.walk(tree, { owner, path: [...ctx.path, id] }, out);
    out.push("</template>");
    for (const name of Object.keys(descriptors)) {
      if (!slotNames.has(name)) continue;
      const light = { owner: ctx.owner, path: ctx.path };
      this.walk(asNode(read(name)), name === "children" ? light : { ...light, slot: name }, out);
    }
    const waits = transferred ? ["@p"] : [];
    if (waits.length > 0) attributes += attribute("data-om", waits.join(" "));
    out[openIndex] = `<${tag}${attributes}><template shadowrootmode="open">`;
    out.push(`</${tag}>`);
  }

  /** 出力の単位の列を、穴の内容を待ってから文字列にする。 */
  async serialize(chunks: Chunk[]): Promise<string> {
    const parts = await Promise.all(chunks.map((chunk) => this.serializeChunk(chunk)));
    return parts.join("");
  }

  private async serializeChunk(chunk: Chunk): Promise<string> {
    if (typeof chunk === "string") return chunk;
    if ("hole" in chunk) return this.serialize(await chunk.hole);
    const { chunks, node, ctx } = chunk.errored;
    try {
      return await this.serialize(chunks);
    } catch (error) {
      return this.serialize(this.chunks(node.fallback(error), ctx));
    }
  }

  /** 描画のために作成した、要素の描画の範囲を破棄する。 */
  dispose(): void {
    for (const dispose of this.disposers) dispose();
  }
}

/** `node` を描画し、すべての非同期の内容を待ってから、HTML の文字列を返す。 */
export async function renderToString(node: unknown): Promise<string> {
  const renderer = new Renderer();
  try {
    return await renderer.serialize(renderer.chunks(asNode(node), { owner: null, path: [] }));
  } finally {
    renderer.dispose();
  }
}
