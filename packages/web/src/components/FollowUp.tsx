import { useLayoutEffect, useRef } from 'preact/hooks';
import { act } from '../api.ts';
import { busy } from '../store.ts';

interface Props {
  id: string;
  placeholder: string;
  hotkey: string;
  /** Focus the field as it mounts (the reply field, opened with R). */
  focus?: boolean;
  /** Esc: by default the field just loses focus. */
  onEscape?: () => void;
  onSent?: () => void;
}

/**
 * A one-line field that sends its text as a reply (spec §6.1): the follow-up of a done session
 * and the reply under a question. It looks like the target's quiet `.k-follow` row at rest.
 * Uncontrolled, so typing re-renders nothing; the text stays when a send fails.
 */
export function FollowUp({ id, placeholder, hotkey, focus, onEscape, onSent }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  // Focus in the render's own task, before the next key arrives: keys typed right after R must
  // land here, never on the board (where a digit would answer the question).
  useLayoutEffect(() => {
    if (focus) ref.current?.focus();
  }, []);
  const sending = busy.value.has(id);
  const onKeyDown = async (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === 'Escape') {
      // Esc here belongs to this field alone: not the New task form, not the board's keys.
      e.preventDefault();
      e.stopPropagation();
      if (onEscape) onEscape();
      else input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      // act refuses a second send while one is in flight.
      if (text !== '' && (await act(id, 'reply', { text }))) {
        input.value = '';
        onSent?.();
      }
    }
  };
  return (
    <label class="k-follow">
      <input
        ref={ref}
        placeholder={placeholder}
        aria-label={placeholder}
        readOnly={sending}
        aria-busy={sending || undefined}
        onKeyDown={onKeyDown}
      />
      <kbd>{hotkey}</kbd>
    </label>
  );
}
