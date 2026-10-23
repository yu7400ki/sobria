export default function NotesError(props: { error: unknown }) {
  return <p id="error">{props.error instanceof Error ? props.error.message : "error"}</p>;
}
