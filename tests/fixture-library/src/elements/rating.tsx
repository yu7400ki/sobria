import { signal, type Ctx } from "sobria";

type Props = { required?: boolean; max?: number };

export default function Rating(props: Props, { form, internals }: Ctx) {
  const [value, setValue] = signal(0);

  internals.role = "radiogroup";
  form.value(() => String(value()));
  form.validity(() =>
    props.required && value() === 0
      ? { valueMissing: true, message: "評価を選んでください" }
      : null,
  );
  form.onReset(() => setValue(0));
  form.onRestore((state) => setValue(Number(state) || 0));

  const stars = Array.from({ length: props.max ?? 5 }, (_, i) => i + 1);
  return (
    <div>
      {stars.map((n) => (
        <button
          type="button"
          role="radio"
          aria-checked={value() === n}
          aria-label={`${n} / ${stars.length}`}
          disabled={form.disabled()}
          onClick={() => setValue(n)}
        >
          {value() >= n ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}
