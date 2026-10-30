import { memo } from "sobria";

type Props = { start: number };

export default function Inner(props: Props) {
  const doubled = memo(async () => {
    await Promise.resolve();
    return props.start * 2;
  });
  return <p>{doubled()}</p>;
}
