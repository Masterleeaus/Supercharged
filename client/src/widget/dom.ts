/**
 * Small DOM helpers. Text from the server or the visitor is always set with textContent, never innerHTML.
 */
export type Attrs = Record<string, string | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, value);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

/** Icon is a fixed inline SVG path, so no server text reaches markup. */
export function iconSvg(doc: Document, pathD: string): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export const ICON_CHAT = "M4 5h16v11H8l-4 4V5z";
export const ICON_CLOSE = "M6 6l12 12M18 6L6 18";
export const ICON_SEND = "M4 12l16-8-6 16-2-7-8-1z";
