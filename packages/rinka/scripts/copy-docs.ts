// ドキュメントサイトの本文の MDX を、パッケージの docs/ にコピーする。
import { resolve } from "node:path";

import { copyDocs } from "./docs.ts";

copyDocs(resolve(import.meta.dirname, "../docs"));
