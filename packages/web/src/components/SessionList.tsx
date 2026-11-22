import { formatAge, groupOf, type Session } from '@kage/shared';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { focusList, newTaskOpen, now, select, selectedId, sorted } from '../store.ts';
import { Archived } from './Archived.tsx';
import { NewTask } from './NewTask.tsx';

function Row({ s }: { s: Session }) {
  const on = s.id === selectedId.value;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(s.id);
    }
  };
  return (
    // The row stays the target's div so the ported CSS applies unchanged; J/K also select.
    // biome-ignore lint/a11y/useSemanticElements: a <button> would need its own reset styles
    <div
      class={on ? 'k-it on' : 'k-it'}
      data-id={s.id}
      role="button"
      tabIndex={0}
      aria-current={on ? 'true' : undefined}
      onClick={() => select(s.id)}
      onKeyDown={onKeyDown}
    >
      <span class="k-name" title={`${s.project} / ${s.task}`}>
        {s.pinned && '★ '}
        <span class="pj">{s.project} /</span> {s.task}
      </span>
      <span class="tm">{formatAge(now.value - s.statusSince)}</span>
      {s.status === 'needs-you' ? (
        <span class="w">
          waiting for your reply
          {s.external && <span class="x"> · external</span>}
        </span>
      ) : (
        s.external && <span class="x">external</span>
      )}
    </div>
  );
}

export function SessionList() {
  const open = newTaskOpen.value;
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // When the form closes, focus goes back to the button it replaced.
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // After this page's archive or delete, the selected row takes the focus the removed session's
  // button had (R77), unless focus is somewhere else that matters (a field, another control).
  const side = useRef<HTMLElement>(null);
  const focus = focusList.value;
  useEffect(() => {
    const a = document.activeElement;
    const elsewhere = a !== null && a !== document.body && !a.closest('.k-main');
    if (focus === 0 || elsewhere || a?.matches('input, textarea')) return;
    side.current?.querySelector<HTMLElement>('.k-it.on')?.focus();
  }, [focus]);
  // The selected row comes into view however it was chosen: a #s= link (R95), the palette, J/K.
  const sel = selectedId.value;
  useEffect(() => {
    side.current?.querySelector('.k-it.on')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);
  const items: JSX.Element[] = [];
  let group: string | null = null;
  for (const s of sorted.value) {
    const g = groupOf(s);
    if (g !== group) {
      group = g;
      items.push(
        <div class="k-g" key={`g:${g}`}>
          {g}
        </div>,
      );
    }
    items.push(<Row s={s} key={s.id} />);
  }
  return (
    <aside class="k-side" ref={side}>
      {open ? (
        <NewTask />
      ) : (
        <button
          ref={button}
          class="k-new"
          type="button"
          onClick={() => {
            newTaskOpen.value = true;
          }}
        >
          ＋ New task <kbd>N</kbd>
        </button>
      )}
      {items}
      <Archived />
    </aside>
  );
}
