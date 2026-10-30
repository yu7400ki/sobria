/** ソースを変換できないことを表す。 */
export class CompileError extends Error {}

/** ソースに構文の誤りがあり、解析できないことを表す。 */
export class ParseError extends CompileError {}
