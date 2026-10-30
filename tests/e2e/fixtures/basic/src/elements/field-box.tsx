import type { Ctx } from "sobria";

import { Field, FieldError, FieldInput, FieldLabel } from "../components/field.tsx";

export default function FieldBox(_props: {}, ctx: Ctx) {
  ctx.onMount(() => ctx.host.setAttribute("data-started", ""));
  return (
    <Field>
      <FieldLabel>title</FieldLabel>
      <FieldInput name="title" />
      <FieldError>required</FieldError>
    </Field>
  );
}
