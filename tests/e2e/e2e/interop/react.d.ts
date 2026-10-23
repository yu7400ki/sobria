// テストで使用する React の関数の型である
declare module "react" {
  export function createElement(type: string, props: Record<string, unknown>): unknown;
}

declare module "react-dom" {
  export function flushSync(fn: () => void): void;
}

declare module "react-dom/client" {
  export function createRoot(container: Element): { render(node: unknown): void; unmount(): void };
}
