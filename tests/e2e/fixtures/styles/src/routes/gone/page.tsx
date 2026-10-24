import { notFound } from "rinka/server";

import "./gone.css";

export default function Gone(): never {
  throw notFound();
}
