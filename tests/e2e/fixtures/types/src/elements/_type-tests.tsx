// @ts-expect-error 要素の tsconfig では、rinka/server はクライアントの型に解決され、defineServerFn を持たない
import { defineServerFn } from "rinka/server";

import Counter from "./counter.tsx";

void defineServerFn;

// @ts-expect-error 要素の tsconfig では、rinka/jsx-runtime は要素の JSX の型に解決され、load:* を受け付けない
void (<Counter start={1} load:idle />);
