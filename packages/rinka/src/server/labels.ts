/**
 * `<label for>` の補完の目印を表す。`label` は `for` を持つ `<label>` で、`host` は `<label>` で名前を補うフォームの部品のホストである。
 * `key` は、tree scope（最も内側の Shadow DOM のホストの ID か、文書を表す空の文字列）と、`for` の値かホストの `id` の組である。
 */
type LabelMark =
  | { readonly kind: "label"; readonly key: string; readonly id: string }
  | { readonly kind: "host"; readonly key: string };

/** tree scope `scope` と `name` の組を、`LabelMark` の `key` にして返す。 */
const keyOf = (scope: string, name: string): string => `${scope} ${name}`;

/**
 * 1 回の描画で、`<label for>` とフォームの部品のホストに出力する目印を作成し、書き出す単位ごとに、ホストの目印を `<label>` を指す `aria-labelledby` に置換する。
 * 目印は、`nonce` を含む文字列で、HTML の文字列に埋め込む。
 */
export class Labels {
  /** `id` を付与した `<label>` の数である。 */
  private seq = 0;
  /** 書き出した単位の `<label>` の `id` を、`LabelMark` の `key` ごとに表す。 */
  private readonly written = new Map<string, string>();
  /** 作成した目印を、目印の番号ごとに表す。 */
  private readonly marks: LabelMark[] = [];
  private readonly prefix: string;
  private readonly pattern: RegExp;
  /** `id` の要素を指す `aria-labelledby` の属性の文字列を返す。 */
  private readonly labelledBy: (id: string) => string;

  constructor(nonce: string, labelledBy: (id: string) => string) {
    this.prefix = `\u0000${nonce}:`;
    this.pattern = new RegExp(`${this.prefix}(\\d+)\u0000`, "g");
    this.labelledBy = labelledBy;
  }

  /**
   * tree scope `scope` にある、`for` の値が `target` の `<label>` の `id` と目印を返す。
   * `given` が文字列か数なら、それを `id` にし、そうでなければ `rinka-l` と連番の `id` を使用する。
   */
  label(
    scope: string,
    target: string,
    given: unknown,
  ): { readonly id: string; readonly mark: string } {
    const id =
      typeof given === "string" || typeof given === "number"
        ? String(given)
        : `rinka-l${++this.seq}`;
    return { id, mark: this.mark({ kind: "label", key: keyOf(scope, target), id }) };
  }

  /** tree scope `scope` にある、`id` を持つフォームの部品のホストの開始タグに出力する目印を返す。 */
  host(scope: string, id: string): string {
    return this.mark({ kind: "host", key: keyOf(scope, id) });
  }

  /**
   * 1 つの単位の HTML の文字列の配列 `htmls` の目印を置換した配列を返す。`<label>` の目印は削除し、ホストの目印は、同じ `key` の `<label>` を指す `aria-labelledby` にする。
   * `<label>` は、既に書き出した単位の `<label>` と、`htmls` の文書の順で最初の `<label>` から探す。該当する `<label>` が無ければ、ホストの目印を削除する。
   * `htmls` の `<label>` は、書き出した単位の `<label>` として記録する。記録の無い番号の目印があれば、エラーを投げる。
   */
  resolve(htmls: readonly string[]): string[] {
    if (!htmls.some((html) => html.includes(this.prefix))) return [...htmls];
    const markOf = (index: string): LabelMark => {
      const mark = this.marks[Number(index)];
      if (mark === undefined)
        throw new Error(`<label for> の補完の目印 ${index} の記録がありません。`);
      return mark;
    };
    const unit = new Map<string, string>();
    for (const html of htmls) {
      for (const [, index = ""] of html.matchAll(this.pattern)) {
        const mark = markOf(index);
        if (mark.kind === "label" && !unit.has(mark.key)) unit.set(mark.key, mark.id);
      }
    }
    const resolved = htmls.map((html) =>
      html.replace(this.pattern, (_match, index: string) => {
        const mark = markOf(index);
        if (mark.kind === "label") return "";
        const id = this.written.get(mark.key) ?? unit.get(mark.key);
        return id === undefined ? "" : this.labelledBy(id);
      }),
    );
    for (const [key, id] of unit) if (!this.written.has(key)) this.written.set(key, id);
    return resolved;
  }

  /** `mark` を記録し、HTML に埋め込む目印の文字列を返す。 */
  private mark(mark: LabelMark): string {
    return `${this.prefix}${this.marks.push(mark) - 1}\u0000`;
  }
}
