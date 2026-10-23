/** `<Navigation>` の props を表す。 */
export interface NavigationProps {
  /** 真なら、ページの遷移に Cross-document View Transitions を使用する。 */
  readonly transitions?: boolean;
  /** 同一オリジンのリンクを先読みする Speculation Rules の `eagerness` である。`false` を指定すると、浅いファイルが指定した先読みを止める。 */
  readonly prefetch?: "conservative" | "moderate" | "eager" | false;
}
