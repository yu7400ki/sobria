import type { PageProps } from "rinka/router";
import { getContext, notFound } from "rinka/server";

export default function User({ params, url }: PageProps<"/users/[id]">) {
  if (params.id === "0") throw notFound();
  if (params.id === "boom") throw new Error("user boom");
  return (
    <p>
      user {params.id} {url.searchParams.get("tab")} {getContext()?.req.header("x-name")}
    </p>
  );
}
