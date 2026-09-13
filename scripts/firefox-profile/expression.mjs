/** Setup files are expressions, optionally terminated by a semicolon. */
export function serializedExpression(source) {
  return `JSON.stringify(\n${source.trim().replace(/;$/, "")}\n)`;
}
