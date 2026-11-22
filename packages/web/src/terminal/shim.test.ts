import { Terminal } from '@xterm/xterm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installStyleShim } from './shim.ts';

// The originals, wrapped in spies before the shim wraps them: what reaches them is untouched.
const create = vi.fn(document.createElement.bind(document));
const set = vi.fn(Element.prototype.setAttribute);
const origSet = Element.prototype.setAttribute;
const origCreate = document.createElement;
const replace = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync');

beforeAll(() => {
  document.createElement = create as unknown as Document['createElement'];
  Element.prototype.setAttribute = set as unknown as Element['setAttribute'];
  installStyleShim(document);
  // A second install wraps nothing again.
  installStyleShim(document);
});
afterAll(() => {
  document.createElement = origCreate;
  Element.prototype.setAttribute = origSet;
});

describe('the CSSOM style shim (R60)', () => {
  it('creates every other element as asked', () => {
    create.mockClear();
    const div = document.createElement('div');
    expect(div.tagName).toBe('DIV');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBe('div');
    expect(document.createElement('span').tagName).toBe('SPAN');
  });

  it('turns a <style> into an inert <template> whose text goes to an adopted sheet', () => {
    const before = document.adoptedStyleSheets.length;
    const el = document.createElement('style');
    expect(el.tagName).toBe('TEMPLATE');
    expect(create.mock.calls.at(-1)?.[0]).toBe('template');
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    el.textContent = '.xterm { color: red; }';
    expect(el.textContent).toBe('.xterm { color: red; }');
    expect(replace).toHaveBeenLastCalledWith('.xterm { color: red; }');
    document.head.append(el);
    el.remove();
    expect(document.adoptedStyleSheets).toHaveLength(before);
    expect(el.isConnected).toBe(false);
  });

  it('drops the sheet when its <template> is taken out with removeChild', () => {
    const before = document.adoptedStyleSheets.length;
    const parent = document.createElement('div');
    const el = document.createElement('style');
    parent.appendChild(el);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    expect(parent.removeChild(el)).toBe(el);
    expect(document.adoptedStyleSheets).toHaveLength(before);
    expect(el.parentNode).toBeNull();
    // Other children go through untouched.
    const span = document.createElement('span');
    parent.appendChild(span);
    expect(parent.removeChild(span)).toBe(span);
    expect(parent.childNodes).toHaveLength(0);
  });

  it('opening and disposing a real terminal ten times leaves the adopted sheets as they were', () => {
    const before = document.adoptedStyleSheets.length;
    for (let i = 0; i < 10; i++) {
      const el = document.createElement('div');
      document.body.append(el);
      const t = new Terminal();
      t.open(el);
      t.write('hi');
      // xterm's DOM renderer makes its three <style> elements.
      expect(document.adoptedStyleSheets.length).toBeGreaterThan(before);
      t.dispose();
      el.remove();
    }
    expect(document.adoptedStyleSheets).toHaveLength(before);
  });

  it("writes an HTML element's style attribute through CSSOM, never setAttribute", () => {
    const span = document.createElement('span');
    const proto = Object.getPrototypeOf(span.style) as CSSStyleDeclaration;
    const cssText = vi.spyOn(proto, 'cssText', 'set');
    span.setAttribute('style', 'color: rgb(215, 119, 87); letter-spacing: 1px');
    expect(cssText).toHaveBeenCalledWith('color: rgb(215, 119, 87); letter-spacing: 1px');
    expect(span.style.color).toBe('rgb(215, 119, 87)');
    expect(span.style.letterSpacing).toBe('1px');
    cssText.mockRestore();
  });

  it('passes every other attribute, and any SVG style, to the original setAttribute', () => {
    const span = document.createElement('span');
    set.mockClear();
    span.setAttribute('class', 'xterm-fg-70');
    span.setAttribute('aria-hidden', 'true');
    span.setAttribute('data-style', 'x');
    expect(set.mock.calls).toEqual([
      ['class', 'xterm-fg-70'],
      ['aria-hidden', 'true'],
      ['data-style', 'x'],
    ]);
    expect(span.getAttribute('class')).toBe('xterm-fg-70');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    set.mockClear();
    svg.setAttribute('style', 'fill: red');
    expect(set.mock.calls).toEqual([['style', 'fill: red']]);
  });
});
