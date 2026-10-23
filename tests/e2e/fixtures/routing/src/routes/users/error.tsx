export default function UserError({ error }: { error: unknown }) {
  return <h1>user error {error instanceof Error ? error.message : ""}</h1>;
}
