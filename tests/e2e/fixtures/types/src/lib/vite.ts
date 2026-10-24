import counter from "../styles/counter.css?raw";

export const pages = import.meta.glob("../routes/**/page.tsx");
export const counterSource: string = counter;
