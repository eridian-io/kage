import { demoSessions } from '@kage/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installKeys } from './keys.ts';
import { applyEvent, confirmingDelete, newTaskOpen, selectedId, sessions } from './store.ts';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
let uninstall: () => void = () => {};

const press = (key: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

beforeEach(() => {
  sessions.value = [];
  selectedId.value = null;
  confirmingDelete.value = false;
  newTaskOpen.value = false;
  applyEvent({
    type: 'snapshot',
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    sessions: demoSessions(NOW),
  });
  uninstall = installKeys(document);
});
afterEach(() => {
  uninstall();
  document.body.innerHTML = '';
});

describe('installKeys', () => {
  it('j and k move the selection', () => {
    expect(selectedId.value).toBe('web');
    press('j');
    expect(selectedId.value).toBe('shop');
    press('k');
    expect(selectedId.value).toBe('web');
  });

  it('stops at the ends of the list', () => {
    press('k');
    expect(selectedId.value).toBe('web');
    for (let i = 0; i < 10; i++) press('j');
    expect(selectedId.value).toBe('docs');
  });

  it('ignores keys typed in an input or a textarea', () => {
    for (const tag of ['input', 'textarea']) {
      const field = document.createElement(tag);
      document.body.append(field);
      press('j', field);
      expect(selectedId.value).toBe('web');
    }
  });

  it('ignores j with a modifier', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    expect(selectedId.value).toBe('web');
  });

  it('Escape cancels the delete confirmation', () => {
    confirmingDelete.value = true;
    press('Escape');
    expect(confirmingDelete.value).toBe(false);
  });

  it('stops listening once uninstalled', () => {
    uninstall();
    press('j');
    expect(selectedId.value).toBe('web');
  });
});

describe('installKeys: the New task form', () => {
  it('n opens the form, and is ignored while typing', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    press('n', field);
    expect(newTaskOpen.value).toBe(false);
    press('n');
    expect(newTaskOpen.value).toBe(true);
    press('N');
    expect(newTaskOpen.value).toBe(true);
  });

  it('N with a modifier does nothing', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));
    expect(newTaskOpen.value).toBe(false);
  });

  it('while the form is open, j, k and Escape leave the board alone (the form owns its keys)', () => {
    newTaskOpen.value = true;
    confirmingDelete.value = true;
    press('j');
    expect(selectedId.value).toBe('web');
    press('Escape');
    expect(confirmingDelete.value).toBe(true);
  });
});
