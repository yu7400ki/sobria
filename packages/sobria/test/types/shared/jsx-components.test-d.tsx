import {
  For,
  createContext,
  createId,
  useContext,
  type ClientNode,
  type ServerNode,
  type SharedNode,
  type Slot,
} from "sobria";
import type { JSX } from "sobria/jsx-runtime";
import { expectTypeOf, test } from "vitest";

const Card = (_props: { title: string }) => null as unknown as SharedNode;

test("共通のコンポーネントの中では、共通のコンポーネントに Props だけを渡せる", () => {
  void (<Card title="t" />);
  // @ts-expect-error ホストの属性は付与できない
  void (<Card title="t" class="wide" />);
});

const Badge = (props: { label: string }) => <span>{props.label}</span>;
const OnlyClient = (_props: object) => null as unknown as ClientNode;
const OnlyServer = (_props: object) => null as unknown as ServerNode;

test("共通のコンポーネントの JSX は、要素とサーバーの両方のノードを返す", () => {
  expectTypeOf(Badge).returns.toEqualTypeOf<SharedNode>();
});

test("共通のコンポーネントの中では、要素のノードだけ、サーバーのノードだけを返すコンポーネントを使用できない", () => {
  // @ts-expect-error 要素のノードだけを返すコンポーネント
  void (<OnlyClient />);
  // @ts-expect-error サーバーのノードだけを返すコンポーネント
  void (<OnlyServer />);
});

test("共通のコンポーネントの SVG と名前に - を含むタグに、イベントハンドラーと ref を記述すると型エラーになる", () => {
  // @ts-expect-error イベントハンドラーは要素の中でだけ記述できる
  void (<svg onClick={() => {}} />);
  // @ts-expect-error ref は要素の中でだけ記述できる
  void (<custom-widget ref={() => {}} />);
});

test("共通のコンポーネントの HTML のタグは、イベントハンドラーの名前を props の候補に含めない", () => {
  expectTypeOf<Extract<keyof JSX.IntrinsicElements["div"], `on${string}`>>().toEqualTypeOf<never>();
});

test("共通のコンポーネントは、スロットの型の children を JSX の子に配置できる", () => {
  void ((props: { children?: Slot }) => <div>{props.children}</div>);
});

test("createContext が返したコンポーネントは value と子を受け取り、useContext は値の型を返す", () => {
  const Theme = createContext<"light" | "dark">("light");
  void (
    <Theme value="dark">
      <Card title="t" />
    </Theme>
  );
  // @ts-expect-error 値の型に合わない value は渡せない
  void (<Theme value="blue" />);
  expectTypeOf(useContext(Theme)).toEqualTypeOf<"light" | "dark">();
  expectTypeOf(createId()).toEqualTypeOf<string>();
});

test("<For> の children は、each の項目の型と、位置を返す関数を受け取り、<For> は共通のノードを返す", () => {
  const rows = [{ id: 1 }];
  const list = (
    <For each={rows}>
      {(row, index) => {
        expectTypeOf(row).toEqualTypeOf<{ id: number }>();
        expectTypeOf(index).toEqualTypeOf<() => number>();
        return <li>{row.id}</li>;
      }}
    </For>
  );
  void list;
  expectTypeOf(For).returns.toEqualTypeOf<import("sobria").SharedNode>();
});
