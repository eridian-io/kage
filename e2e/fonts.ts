import type { Page } from '@playwright/test';
import { BASE } from './env.ts';

/** The weights the design target asks Google Fonts for, and the app's file for each. */
const FACES: [family: string, weight: number, file: string][] = [
  ['Geist', 400, 'geist-latin-400-normal.woff2'],
  ['Geist', 500, 'geist-latin-500-normal.woff2'],
  ['Geist', 600, 'geist-latin-600-normal.woff2'],
  ['Geist', 700, 'geist-latin-700-normal.woff2'],
  ['Geist Mono', 400, 'geist-mono-latin-400-normal.woff2'],
  ['Geist Mono', 500, 'geist-mono-latin-500-normal.woff2'],
];

const CSS = FACES.map(
  ([family, weight, file]) =>
    `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;` +
    `src:url(${BASE}/fonts/${file}) format("woff2")}`,
).join('\n');

/**
 * Serves the design target's Google Fonts stylesheet from the app's own font files, so the
 * target and the app render with identical fonts and no request leaves the machine.
 * The target is a file:// page, and fonts load in CORS mode, so the font responses get an
 * Access-Control-Allow-Origin header here.
 */
export async function routeGoogleFonts(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname === 'fonts.googleapis.com' && url.pathname.startsWith('/css2'),
    (route) => route.fulfill({ status: 200, contentType: 'text/css', body: CSS }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route(`${BASE}/fonts/*`, async (route) => {
    // Only the body is passed on: route.fetch() has already decoded any Content-Encoding.
    const res = await route.fetch();
    await route.fulfill({
      status: res.status(),
      contentType: 'font/woff2',
      headers: { 'access-control-allow-origin': '*' },
      body: await res.body(),
    });
  });
}
