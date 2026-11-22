import { expect, type Page, test } from '@playwright/test';
import { DEMO_NOW, resetDemo } from './env.ts';

/**
 * The command palette end to end (Task 8, spec §6.4) on the demo board: the lazy chunk opens on
 * Ctrl+K (⌘K on a Mac, R97) or the hint button, its roles match the combobox pattern, a fuzzy query
 * jumps to a session, and Esc closes only the palette and gives focus back.
 */

test.beforeEach(async ({ page }) => {
  await resetDemo();
  await page.clock.setFixedTime(DEMO_NOW);
  await page.goto('/');
  await expect(page.locator('.k-it.on')).toHaveText(/dark mode/);
});

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const input = (page: Page) => palette(page).getByRole('combobox');
/** The palette's key here: ⌘K on a Mac, Ctrl+K elsewhere (R97). */
const openKey = (page: Page) => page.keyboard.press('ControlOrMeta+k');

test('Ctrl+K opens a combobox over a listbox of grouped options', async ({ page }) => {
  await openKey(page);
  await expect(input(page)).toBeFocused();
  // The demo selects web / dark mode (needs you, with files): its own actions follow the sessions.
  await expect(palette(page)).toMatchAriaSnapshot(`
    - dialog "Command palette":
      - combobox
      - listbox "Results":
        - group "sessions":
          - option "web / dark mode needs you" [selected]
          - option "shop-api / fix login bug running"
          - option "infra / node 24 running"
          - option "shop-api / rate limit v1 done"
          - option "web / fix footer links done"
          - option "docs / update README done"
        - group "this session":
          - option "View diff"
          - option "Open the terminal T"
          - option "Pin S"
          - option "Stop X"
        - group "general":
          - option "New task N"
      - status: 11 results
  `);
});

test('a fuzzy query and Enter select the session and focus its row', async ({ page }) => {
  await openKey(page);
  // The chunk loads on the first open: type once its input has focus.
  await expect(input(page)).toBeFocused();
  await page.keyboard.type('ur');
  await expect(palette(page).getByRole('option').first()).toHaveText(/docs \/ update README/);
  await expect(palette(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator('.k-it.on')).toHaveText(/update README/);
  await expect(page.locator('.k-head .k-task')).toHaveText('update README');
  await expect(page.locator('.k-it.on')).toBeFocused();
});

test('Esc closes the palette and gives focus back', async ({ page }) => {
  const shop = page.locator('.k-it', { hasText: 'fix login bug' });
  await shop.click();
  await expect(shop).toBeFocused();
  await openKey(page);
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(shop).toBeFocused();
  await expect(page.locator('.k-it.on')).toHaveText(/fix login bug/);
});

test('over the diff view, Esc closes only the palette', async ({ page }) => {
  await page.getByRole('button', { name: /View diff/ }).click();
  const diff = page.locator('.k-dv');
  // The diff's chunk takes focus when it mounts; demo mode then answers with its sentence.
  await expect(diff).toContainText("Demo mode can't show diffs.");
  await openKey(page);
  await expect(input(page)).toBeFocused();
  // The diff's own command is gone while it is open.
  await expect(palette(page).getByRole('option', { name: 'View diff' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(diff).toBeVisible();
});

test('while the terminal is open, Ctrl+K is its key and opens nothing', async ({ page }) => {
  // Demo mode refuses the terminal socket (4501) and the view closes; a stub chunk keeps it open.
  await page.route(/\/term-[^/]+\.js$/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export function mountTerminal(el) {
        el.textContent = 'stub terminal';
        return { focus() {}, dispose() {} };
      }`,
    }),
  );
  await page.keyboard.press('t');
  await expect(page.locator('.k-term')).toContainText('stub terminal');
  await openKey(page);
  await expect(page.locator('.k-term')).toContainText('stub terminal');
  await expect(palette(page)).toHaveCount(0);
});

test('a click on the hint opens it, and a second click closes it', async ({ page }) => {
  const hint = page.getByRole('button', { name: 'Command palette' });
  await hint.click();
  await expect(input(page)).toBeFocused();
  await hint.click();
  await expect(palette(page)).toHaveCount(0);
});
