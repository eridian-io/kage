import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { DEMO_NOW, resetDemo } from './env.ts';
import { routeGoogleFonts } from './fonts.ts';

const WIDTH = 1320;
const HEIGHT = 900;
/** Fail at 0.5% of the viewport's pixels or more. */
const MAX_DIFF = 0.005;
const TARGET = `${pathToFileURL(join(import.meta.dirname, '../docs/design/kage-board.html')).href}#full`;
const OUT = join(import.meta.dirname, '../test-results');

interface State {
  name: string;
  /** Brings the design target into the state. */
  target: (page: Page) => Promise<void>;
  /** Brings the app into the same state. */
  app: (page: Page) => Promise<void>;
}

const row = (page: Page, task: string) => page.locator('.k-it', { hasText: task });

const STATES: State[] = [
  { name: 'needs-you', target: async () => {}, app: async () => {} },
  {
    name: 'running',
    target: (page) => page.click('[data-id="shop"]'),
    app: (page) => row(page, 'fix login bug').click(),
  },
  {
    name: 'done',
    target: (page) => page.click('[data-id="docs"]'),
    app: (page) => row(page, 'update README').click(),
  },
  {
    name: 'delete-confirm',
    target: async (page) => {
      await page.click('[data-id="docs"]');
      await page.click('[data-act="confirm-del"]');
    },
    app: async (page) => {
      await row(page, 'update README').click();
      await page.getByRole('button', { name: 'Delete…' }).click();
      await expect(page.getByText('Delete this session?')).toBeVisible();
    },
  },
];

/** Freezes the blinking cursor, parks the mouse where nothing hovers, waits for fonts. */
async function settle(page: Page): Promise<Buffer> {
  await page.addStyleTag({ content: '.cursor{animation:none}' });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.screenshot({ animations: 'disabled' });
}

test.beforeEach(async ({ page }) => {
  await resetDemo();
  await page.clock.setFixedTime(DEMO_NOW);
});

for (const state of STATES) {
  test(`the app matches the design target: ${state.name}`, async ({ page }) => {
    await routeGoogleFonts(page);
    await page.goto(TARGET);
    await expect(page.locator('.v1-it')).toHaveCount(6);
    await state.target(page);
    const want = PNG.sync.read(await settle(page));

    await page.goto('/');
    await expect(page.locator('.k-it')).toHaveCount(6);
    await state.app(page);
    const got = PNG.sync.read(await settle(page));

    expect([got.width, got.height]).toEqual([WIDTH, HEIGHT]);
    expect([want.width, want.height]).toEqual([WIDTH, HEIGHT]);
    const diff = new PNG({ width: WIDTH, height: HEIGHT });
    const differing = pixelmatch(want.data, got.data, diff.data, WIDTH, HEIGHT, {
      threshold: 0.1,
    });
    const ratio = differing / (WIDTH * HEIGHT);
    console.log(`${state.name}: ${differing} differing pixels (${(ratio * 100).toFixed(3)}%)`);
    if (ratio >= MAX_DIFF) {
      await mkdir(OUT, { recursive: true });
      await Promise.all([
        writeFile(join(OUT, `${state.name}-diff.png`), PNG.sync.write(diff)),
        writeFile(join(OUT, `${state.name}-target.png`), PNG.sync.write(want)),
        writeFile(join(OUT, `${state.name}-app.png`), PNG.sync.write(got)),
      ]);
    }
    expect(ratio, `differing pixels in ${state.name}`).toBeLessThan(MAX_DIFF);
  });
}
