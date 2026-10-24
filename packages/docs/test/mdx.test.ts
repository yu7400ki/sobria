import { describe, expect, it } from "vitest";

import { toTsx } from "../plugins/mdx.ts";

/** コードブロックのコンポーネントの指定子を設定して、`source` を TSX にする。 */
const tsx = (source: string) => toTsx(source, { codeBlock: "/code-block.tsx" });

/** `source` から生成した TSX の、本文のコンポーネントが返す JSX を返す。 */
async function body(source: string): Promise<string> {
  const code = await tsx(source);
  const match = /return <>(.*)<\/>;\n\}$/s.exec(code);
  if (match === null) throw new Error(code);
  return match[1]!;
}

describe("toTsx", () => {
  it("frontmatter を export する", async () => {
    expect(await tsx("---\ntitle: 題名\n---\n\n本文")).toContain(
      'export const frontmatter = {"title":"題名"};',
    );
  });

  it("frontmatter が無ければ、空のオブジェクトを export する", async () => {
    expect(await tsx("本文")).toContain("export const frontmatter = {};");
  });

  it("見出しに ID を付け、深さ 2 と 3 の見出しを目次として export する", async () => {
    const code = await tsx(
      "# 題名\n\n## 使い方 `css`\n\n### Props と属性\n\n## 使い方 `css`\n\n#### 深い",
    );
    expect(code).toContain(
      'export const toc = [{"depth":2,"id":"使い方-css","text":"使い方 css"},{"depth":3,"id":"props-と属性","text":"Props と属性"},{"depth":2,"id":"使い方-css-1","text":"使い方 css"}];',
    );
    expect(code).toContain('<h1 id={"題名"}>{"題名"}</h1>');
    expect(code).toContain('<h2 id={"使い方-css"}>{"使い方 "}<code>{"css"}</code></h2>');
    expect(code).toContain('<h4 id={"深い"}>{"深い"}</h4>');
  });

  it("テキストを文字列のリテラルとして出力する", async () => {
    expect(await body(String.raw`a \{b\} \<c\> "d" &lt;`)).toBe(
      String.raw`<p>{"a {b} <c> \"d\" <"}</p>`,
    );
  });

  it("インラインの記法をタグにする", async () => {
    expect(await body('*a* **b** ~~c~~ [d](/d "D") ![e](/e.png)  \nf')).toBe(
      '<p><em>{"a"}</em>{" "}<strong>{"b"}</strong>{" "}<del>{"c"}</del>{" "}<a href={"/d"} title={"D"}>{"d"}</a>{" "}<img src={"/e.png"} alt={"e"} /><br />{"f"}</p>',
    );
  });

  it("詰めたリストの項目は、段落を p で囲まない", async () => {
    expect(await body("- a\n- [x] b\n\n1. c")).toBe(
      '<ul><li>{"a"}</li><li><input type="checkbox" checked disabled />{" "}{"b"}</li></ul><ol><li>{"c"}</li></ol>',
    );
  });

  it("空けたリストの項目は、段落を p で囲む", async () => {
    expect(await body("3. a\n\n4. b")).toBe(
      '<ol start={3}><li><p>{"a"}</p></li><li><p>{"b"}</p></li></ol>',
    );
  });

  it("引用と区切り線をタグにする", async () => {
    expect(await body("> a\n\n---")).toBe('<blockquote><p>{"a"}</p></blockquote><hr />');
  });

  it("表の 1 行目を見出しにし、列の揃え方を style にする", async () => {
    expect(await body("| a | b |\n|:-|-:|\n| 1 | 2 |")).toBe(
      '<table><thead><tr><th style={"text-align: left"}>{"a"}</th><th style={"text-align: right"}>{"b"}</th></tr></thead><tbody><tr><td style={"text-align: left"}>{"1"}</td><td style={"text-align: right"}>{"2"}</td></tr></tbody></table>',
    );
  });

  it("コードブロックを色付けし、元のコードとともにコードブロックのコンポーネントに渡す", async () => {
    const code = await tsx("```ts\nconst a = 1\n```");
    expect(code).toContain('import MdxCodeBlock from "/code-block.tsx";');
    expect(code).toContain('<MdxCodeBlock code={"const a = 1"} lang={"ts"}><pre class={"shiki');
    expect(code).toContain(
      '<span style={"--shiki-light:#D73A49;--shiki-dark:#F97583"}>{"const"}</span>',
    );
  });

  it("言語の無いコードブロックは、色付けせずにテキストとして渡す", async () => {
    expect(await body("```\n<a>\n```")).toContain('<MdxCodeBlock code={"<a>"}><pre class={"shiki');
  });

  it("MDX の ESM、JSX、式をそのまま出力する", async () => {
    const code = await tsx(
      'import Card from "./card.tsx"\nexport const n = 2\n\n<Card count={n} label="x" open {...rest}>\n中身 {n}\n</Card>',
    );
    expect(code).toContain('import Card from "./card.tsx"\nexport const n = 2\n');
    expect(code).toContain('<Card count={n} label={"x"} open {...rest}><p>{"中身 "}{n}</p></Card>');
  });

  it("変換できないノードは、エラーにする", async () => {
    await expect(tsx("a[^1]\n\n[^1]: b")).rejects.toThrow("変換できません");
  });

  it("小文字で始まるタグは、HTML として解析されるのでエラーにする", async () => {
    await expect(tsx("<aside>a</aside>")).rejects.toThrow("大文字で始まるコンポーネント");
  });

  it("コードブロックより後のノードのエラーは、色付けのエラーより先に投げる", async () => {
    await expect(tsx("```foo\nx\n```\n\n<aside>a</aside>")).rejects.toThrow("HTML として解析");
  });

  it("番号を付けた ID が別の見出しの ID と同じなら、番号を進める", async () => {
    const code = await tsx("## a\n\n## a-1\n\n## a");
    expect(code).toContain('<h2 id={"a-1"}>{"a-1"}</h2><h2 id={"a-2"}>{"a"}</h2>');
  });

  it("ID にできる文字の無い見出しには、section の ID を付ける", async () => {
    expect(await body("## !!!\n\n## ???")).toBe(
      '<h2 id={"section"}>{"!!!"}</h2><h2 id={"section-1"}>{"???"}</h2>',
    );
  });

  it("見出しの画像の alt を ID と目次に含め、前後の空白を除く", async () => {
    expect(await tsx("## ![図](/a.png) 説明 ")).toContain(
      'export const toc = [{"depth":2,"id":"図-説明","text":"図 説明"}];',
    );
  });

  it("チェックの無いタスクのチェックボックスには、checked を付けない", async () => {
    expect(await body("- [ ] a")).toBe(
      '<ul><li><input type="checkbox" disabled />{" "}{"a"}</li></ul>',
    );
  });

  it("空けたリストのタスクのチェックボックスは、最初の段落の中に置く", async () => {
    expect(await body("- [ ] a\n\n- [x] b")).toBe(
      '<ul><li><p><input type="checkbox" disabled />{" "}{"a"}</p></li><li><p><input type="checkbox" checked disabled />{" "}{"b"}</p></li></ul>',
    );
  });

  it("揃え方を指定しない列には、style を付けない", async () => {
    expect(await body("| a | b |\n|---|:-:|\n| 1 | 2 |")).toBe(
      '<table><thead><tr><th>{"a"}</th><th style={"text-align: center"}>{"b"}</th></tr></thead><tbody><tr><td>{"1"}</td><td style={"text-align: center"}>{"2"}</td></tr></tbody></table>',
    );
  });

  it("複数のコードブロックを、記述した順に色付けの結果に置き換える", async () => {
    const code = await body("```ts\na\n```\n\n```js\nb\n```");
    expect(code.indexOf('code={"a"} lang={"ts"}')).toBeGreaterThan(-1);
    expect(code.indexOf('code={"b"} lang={"js"}')).toBeGreaterThan(code.indexOf('code={"a"}'));
  });

  it("参照形式のリンクを、定義の URL へのリンクにする", async () => {
    expect(await body("[a][b]\n\n[b]: /x")).toBe('<p><a href={"/x"}>{"a"}</a></p>');
  });

  it("ESM の export default は、エラーにする", async () => {
    await expect(tsx("export default 1")).rejects.toThrow("export default");
  });
});
