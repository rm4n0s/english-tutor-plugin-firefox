/** Test helpers for the markdown renderer. Not part of the extension. */

/** The elements the renderer may create (SPEC section 5.9). */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "br",
]);

/** The attributes the renderer may set, by element. */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "target", "rel"]),
};

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A compact serialisation of rendered nodes, built by hand (the code never reads `innerHTML`). */
export function serialize(node: Node): string {
  if (node.nodeType === 3) return escapeText(node.textContent ?? "");
  if (node instanceof Element) {
    const name = node.localName;
    const attrs = [...node.attributes].map((a) => ` ${a.name}="${escapeText(a.value)}"`).join("");
    if (name === "br") return "<br>";
    return `<${name}${attrs}>${[...node.childNodes].map(serialize).join("")}</${name}>`;
  }
  return [...node.childNodes].map(serialize).join("");
}

/** Every problem with the elements and attributes below `root`, as messages. */
export function violations(root: Node): string[] {
  const found: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) return;
    if (node instanceof Element) {
      const name = node.localName;
      if (!ALLOWED_ELEMENTS.has(name)) found.push(`element <${name}>`);
      const allowed = ALLOWED_ATTRIBUTES[name];
      for (const attribute of node.attributes) {
        if (allowed?.has(attribute.name) !== true)
          found.push(`attribute ${name}@${attribute.name}`);
      }
      if (name === "a") {
        const href = node.getAttribute("href") ?? "";
        if (!/^https?:\/\/[^/\s]/.test(href)) found.push(`link to ${href}`);
        if (node.parentElement?.closest("a") != null) {
          found.push("nested link");
        }
      }
    } else if (node.nodeType !== 11) {
      found.push(`node type ${String(node.nodeType)}`);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
