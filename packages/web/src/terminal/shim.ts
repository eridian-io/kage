/**
 * R60: xterm 6's DOM renderer under Kage's CSP (`style-src 'self'`, no nonce, no 'unsafe-inline').
 * xterm creates three <style> elements and writes truecolor cells with setAttribute('style', …);
 * CSP blocks both. CSSOM writes aren't checked by CSP, so (host-integration.md §4.7):
 * - document.createElement('style') returns an inert <template> whose textContent goes into a
 *   constructable sheet in document.adoptedStyleSheets, and whose remove() drops that sheet
 *   (an empty real <style> still reports a violation);
 * - setAttribute('style', v) on an HTMLElement sets el.style.cssText instead.
 * Every other element and attribute goes through untouched. Installed once per document, by the
 * terminal chunk only, before `new Terminal()`.
 */
const done = new WeakSet<Document>();

export function installStyleShim(doc: Document = document): void {
  if (done.has(doc)) return;
  done.add(doc);
  const create = doc.createElement;
  doc.createElement = function (this: Document, tag: string, o?: ElementCreationOptions) {
    const style = String(tag).toLowerCase() === 'style';
    const el = create.call(this, style ? 'template' : tag, o);
    if (style) {
      const sheet = new CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      let text = '';
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        get: () => text,
        set: (v: unknown) => {
          text = String(v ?? '');
          sheet.replaceSync(text);
        },
      });
      const rm = el.remove.bind(el);
      el.remove = () => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
        rm();
      };
    }
    return el;
  } as Document['createElement'];
  const view = doc.defaultView ?? globalThis;
  const proto = (view as typeof globalThis).Element.prototype;
  const set = proto.setAttribute;
  const Html = (view as typeof globalThis).HTMLElement;
  // A DOM whose cssText setter writes the attribute itself (happy-dom) must not loop back here.
  let inside = false;
  proto.setAttribute = function (this: Element, name: string, value: string) {
    if (name === 'style' && this instanceof Html && !inside) {
      inside = true;
      try {
        this.style.cssText = value;
      } finally {
        inside = false;
      }
      return;
    }
    set.call(this, name, value);
  };
}
