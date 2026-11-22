/**
 * Apple platforms, where ⌘ is the command key and Ctrl+K is a text field's kill-line (R97). Read on
 * each call, so a test can stub `navigator.platform`.
 */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The palette's key as the hint shows it. */
export const paletteHint = (): string => (isMac() ? '⌘K' : 'Ctrl+K');
