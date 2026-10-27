import type { Ctx } from "rinka";

type Props = {
  count: number;
  /** ボタンを押したときに、1 を足した数で呼ぶ。 */
  onLikeClick?: (count: number) => void;
};

interface Methods {
  /** ボタンをフォーカスする。 */
  focusButton(): void;
}

export default function Counter(props: Props, { expose, host }: Ctx<Methods>) {
  expose({ focusButton: () => host.shadowRoot?.querySelector("button")?.focus() });
  return <button onClick={() => props.onLikeClick?.(props.count + 1)}>{props.count}</button>;
}
