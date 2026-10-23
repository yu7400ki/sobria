import { href } from "rinka/router";
// @ts-expect-error 要素の tsconfig では、rinka/server はクライアントの型に解決され、defineServerFn を持たない
import { defineServerFn } from "rinka/server";

void defineServerFn;

// @ts-expect-error 存在しないページのルートである
void href("/missing");

// @ts-expect-error ルートのパラメータが不足している
void href("/users/[id]", {});

// @ts-expect-error 要素の型に無いメンバーである
void document.querySelector("app-counter")?.missing;
