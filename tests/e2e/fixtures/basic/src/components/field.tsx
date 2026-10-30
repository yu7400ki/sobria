import { createContext, createId, useContext } from "sobria";

/** `<Field>` の入力欄とエラーの文の id である。 */
type FieldIds = { readonly input: string; readonly error: string };

const FieldContext = createContext<FieldIds>({ input: "", error: "" });

/** ラベル、入力欄、エラーの文を、id で関連付けるフィールドである。 */
export function Field(props: { children?: JSX.Element }) {
  return (
    <FieldContext value={{ input: createId(), error: createId() }}>
      <div class="field">{props.children}</div>
    </FieldContext>
  );
}

/** フィールドの入力欄を指すラベルである。 */
export function FieldLabel(props: { children?: JSX.Element }) {
  return <label for={useContext(FieldContext).input}>{props.children}</label>;
}

/** エラーの文で説明される、フィールドの入力欄である。 */
export function FieldInput(props: { name: string }) {
  const ids = useContext(FieldContext);
  return <input name={props.name} id={ids.input} aria-describedby={ids.error} />;
}

/** フィールドのエラーの文である。 */
export function FieldError(props: { children?: JSX.Element }) {
  return <p id={useContext(FieldContext).error}>{props.children}</p>;
}
