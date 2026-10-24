import "./broken.css";

export default function Broken(): never {
  throw new Error("broken");
}
