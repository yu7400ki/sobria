import { createRoot, flush } from "@solidjs/signals";
import { describe, expect, it } from "vitest";

import { For } from "../../src/client/control.ts";
import { jsx } from "../../src/client/jsx-runtime.ts";
import { signal } from "../../src/shared/signals.ts";
import { toNode } from "./nodes.ts";

/** `list` の項目を `<li>` にする `<For>` を `<ul>` に描画し、`<ul>` と、項目の関数を呼んだ記録を返す。 */
function mountList<T>(list: () => readonly T[] | null, label: (item: T) => string) {
  const runs: string[] = [];
  const ul = createRoot(() =>
    toNode<HTMLUListElement>(
      jsx("ul", {
        children: jsx(For<T>, {
          get each() {
            return list();
          },
          children: (item: T, index: () => number) => {
            runs.push(label(item));
            return jsx("li", { children: () => `${index()}:${label(item)}` });
          },
        }),
      }),
    ),
  );
  return { ul, runs };
}

const texts = (ul: HTMLUListElement) => [...ul.querySelectorAll("li")].map((li) => li.textContent);

describe("<For>", () => {
  it("項目の関数は、項目が加わったときに 1 回だけ呼び、残った項目のノードを作成し直さない", () => {
    const [list, setList] = signal(["a", "b"]);
    const { ul, runs } = mountList(list, (item) => item);
    const [a, b] = ul.querySelectorAll("li");
    setList(["a", "b", "c"]);
    flush();
    setList(["b", "c"]);
    flush();
    expect(texts(ul)).toEqual(["0:b", "1:c"]);
    expect(ul.querySelector("li")).toBe(b);
    expect(a?.isConnected).toBe(false);
    expect(runs).toEqual(["a", "b", "c"]);
  });

  it("並べ替えると、index は新しい位置を返し、項目の関数の中で作成した Signal は保たれる", () => {
    const [list, setList] = signal(["x", "y"]);
    const counts = new Map<string, (value: number) => void>();
    const ul = createRoot(() =>
      toNode<HTMLUListElement>(
        jsx("ul", {
          children: jsx(For<string>, {
            get each() {
              return list();
            },
            children: (item: string, index: () => number) => {
              const [count, setCount] = signal(0);
              counts.set(item, setCount);
              return jsx("li", { children: () => `${index()}:${item}${count()}` });
            },
          }),
        }),
      ),
    );
    counts.get("x")!(1);
    setList(["y", "x"]);
    flush();
    expect(texts(ul)).toEqual(["0:y0", "1:x1"]);
  });

  it("項目の最上位の領域が中身を置換した後に配列が変化しても、領域の新しい中身を描画する", () => {
    const [list, setList] = signal(["a", "b", "c"]);
    const [inner, setInner] = signal(["1"]);
    const div = createRoot(() =>
      toNode<HTMLDivElement>(
        jsx("div", {
          children: jsx(For<string>, {
            get each() {
              return list();
            },
            children: (item: string, index: () => number) => [
              () => `${index()}`,
              `:${item}`,
              jsx(For<string>, {
                get each() {
                  return inner();
                },
                children: (value: string) => value,
              }),
              ";",
            ],
          }),
        }),
      ),
    );
    setInner(["1", "2"]);
    flush();
    setList(["c", "a"]);
    flush();
    expect(div.textContent).toBe("0:c12;1:a12;");
  });

  it("項目の中の領域と配列が同じ flush で変化しても、領域の新しい中身を描画する", () => {
    const [list, setList] = signal(["a", "b", "c"]);
    const [inner, setInner] = signal("1");
    const div = createRoot(() =>
      toNode<HTMLDivElement>(
        jsx("div", {
          children: jsx(For<string>, {
            get each() {
              return list();
            },
            children: (item: string) => [`${item}:`, () => inner(), ";"],
          }),
        }),
      ),
    );
    setInner("2");
    setList(["c", "a"]);
    flush();
    expect(div.textContent).toBe("c:2;a:2;");
  });

  it("each が null なら何も描画せず、配列に変化したら項目を描画する", () => {
    const [list, setList] = signal<readonly string[] | null>(null);
    const { ul } = mountList(list, (item) => item);
    expect(texts(ul)).toEqual([]);
    setList(["a"]);
    flush();
    expect(texts(ul)).toEqual(["0:a"]);
  });
});
