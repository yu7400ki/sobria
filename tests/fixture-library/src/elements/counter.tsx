type Props = {
  count: number;
  onLikeClick?: (count: number) => void;
};

export default function Counter(props: Props) {
  return <button onClick={() => props.onLikeClick?.(props.count + 1)}>{props.count}</button>;
}
