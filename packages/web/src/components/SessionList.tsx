import { formatAge, groupOf, type Session } from '@kage/shared';
import { Component, type JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { NewTaskHost } from '../lazy.tsx';
import { focusList, newTaskOpen, now, select, selectedId, sorted } from '../store.ts';
import { Archived } from './Archived.tsx';

interface RowProps {
  s: Session;
  /** Selected. */
  on: boolean;
  /** formatAge(now - s.statusSince), worked out by the list. */
  age: string;
}

/** The fields of a session a row shows: anything else (the now line, lines, files) is ignored. */
const SHOWN = ['status', 'statusSince', 'pinned', 'external', 'project', 'task'] as const;

/**
 * One row of the left column. A class with shouldComponentUpdate, as Output.tsx's Line (performance
 * P3): every session.updated replaces the list, and most (the now line, up to 4 a second per
 * running session) change nothing a row shows, so only a row whose own fields, selection or age
 * text changed renders again. It reads no signal itself: the list hands it `on` and `age`.
 */
export class Row extends Component<RowProps> {
  override shouldComponentUpdate(next: RowProps): boolean {
    const { s, on, age } = this.props;
    return next.on !== on || next.age !== age || SHOWN.some((k) => next.s[k] !== s[k]);
  }

  #select = () => select(this.props.s.id);

  #onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.#select();
    }
  };

  override render() {
    const { s, on, age } = this.props;
    return (
      // The row stays the target's div so the ported CSS applies unchanged; J/K also select.
      // biome-ignore lint/a11y/useSemanticElements: a <button> would need its own reset styles
      <div
        class={on ? 'k-it on' : 'k-it'}
        data-id={s.id}
        role="button"
        tabIndex={0}
        aria-current={on ? 'true' : undefined}
        onClick={this.#select}
        onKeyDown={this.#onKeyDown}
      >
        <span class="k-name" title={`${s.project} / ${s.task}`}>
          {s.pinned && '★ '}
          <span class="pj">{s.project} /</span> {s.task}
        </span>
        <span class="tm">{age}</span>
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
  const t = now.value;
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
    items.push(<Row s={s} on={s.id === sel} age={formatAge(t - s.statusSince)} key={s.id} />);
  }
  return (
    <aside class="k-side" ref={side}>
      {open ? (
        <NewTaskHost />
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
