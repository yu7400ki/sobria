import { Field, FieldError, FieldInput, FieldLabel } from "../../components/field.tsx";
import FieldBox from "../../elements/field-box.tsx";

export default function Page() {
  return (
    <main>
      <Field>
        <FieldLabel>name</FieldLabel>
        <FieldInput name="name" />
        <FieldError>required</FieldError>
      </Field>
      <FieldBox />
    </main>
  );
}
