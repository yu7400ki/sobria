import { notFound } from "sobria/server";

import "./gone.css";

export default function Gone(): never {
  throw notFound();
}
