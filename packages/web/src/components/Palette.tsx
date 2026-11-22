import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NotifyApi } from '../notify.ts';
import { type Command, type CommandGroup, commands, textOf } from '../palette/commands.ts';
import { rank } from '../palette/fuzzy.ts';
import { paletteOpen } from '../store.ts';

/** How many results show; past it, "Keep typing to see more." */
export const LIMIT = 50;
const STATUS: Record<string, [word: string, cls: string]> = {
  'needs-you': ['needs you', ' k-pal-wait'],
  running: ['running', ' k-pal-run'],
  done: ['done', ''],
  ended: ['ended', ''],
};
const groupId = (g: CommandGroup) => `k-pal-g-${g.replace(' ', '-')}`;

/** text[from, to) with the hits in it as <b> spans: text nodes only, never HTML. */
function marked(text: string, hits: readonly number[], from: number, to: number) {
  const out: ComponentChildren[] = [];
  let plain = from;
  for (const h of hits) {
    if (h < from || h >= to) continue;
    if (h > plain) out.push(text.slice(plain, h));
    out.push(<b key={h}>{text[h]}</b>);
    plain = h + 1;
  }
  if (plain < to) out.push(text.slice(plain, to));
  return out;
}

interface Row {
  c: Command;
  hits: number[];
}

function Label({ c, hits }: Row) {
  const s = c.session;
  if (!s || c.group !== 'sessions') return <>{marked(c.title, hits, 0, c.title.length)}</>;
  // The title is `project / task`: "project /" quiet, as in the list, then the task.
  const cut = s.project.length + 2;
  return (
    <>
      <span class="pj">{marked(c.title, hits, 0, cut)}</span>
      {marked(c.title, hits, cut, c.title.length)}
    </>
  );
}

/**
 * The command palette (Task 8, spec §6.4): a modal combobox over the board's sessions and actions,
 * the lazy chunk palette-*.js (R95). Commands are built when it opens; the query ranks them with
 * fuzzy(). Focus stays in the input; on a close without a command it returns where it was.
 */
export function Palette({ notify }: { notify: NotifyApi }) {
  const [back] = useState(() => document.activeElement);
  const [all, setAll] = useState(() => commands(notify));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** A command that places focus itself ran: don't return it on close. */
  const moved = useRef(false);

  const ranked = useMemo(() => rank(query, all, textOf, LIMIT + 1), [query, all]);
  const more = ranked.length > LIMIT;
  // Grouped in the order each group first ranks, so the best match is the first option.
  const groups: { g: CommandGroup; rows: Row[] }[] = [];
  for (const { item, match } of more ? ranked.slice(0, LIMIT) : ranked) {
    let group = groups.find((x) => x.g === item.group);
    if (!group) {
      group = { g: item.group, rows: [] };
      groups.push(group);
    }
    group.rows.push({ c: item, hits: match.hits });
  }
  const flat = groups.flatMap((g) => g.rows);
  const n = flat.length;
  const at = Math.min(active, Math.max(0, n - 1));

  const close = () => {
    paletteOpen.value = false;
  };
  /**
   * The list on screen is a snapshot from the open; the command runs as it is now. The same id for
   * the same session must still be offered and enabled (this session's items exist only for the
   * session selected now), else nothing runs.
   */
  const run = (shown: Command | undefined) => {
    if (!shown || shown.disabled) return;
    const c = commands(notify).find(
      (x) => x.id === shown.id && x.session?.id === shown.session?.id,
    );
    if (!c || c.disabled) return;
    moved.current = c.moves === true;
    close();
    c.run();
  };

  // Before paint: the first key typed after ⌘K lands in the input.
  useLayoutEffect(() => {
    // The permission may have changed in the browser's settings since the page loaded (R95).
    const was = notify.state.value;
    notify.read();
    if (notify.state.value !== was) setAll(commands(notify));
    input.current?.focus();
    // A press outside closes it; focus goes where the press puts it. The ⌘K button toggles itself.
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (panel.current?.contains(t) || t?.closest?.('.k-k')) return;
      moved.current = true;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      if (!moved.current && back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  useEffect(() => {
    document.getElementById(`k-pal-o${at}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at, query]);

  const onKeyDown = (e: KeyboardEvent) => {
    // An IME's own Enter and arrows (Safari sends 229 just after composing).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) run(flat[at]?.c);
    } else if (e.key === 'Escape') {
      // Only the palette closes: not the diff, the form or the confirmation under it.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) close();
    } else if (e.key === 'Tab') {
      // Modal: focus stays in the input.
      e.preventDefault();
    }
  };

  let i = 0;
  const option = ({ c, hits }: Row): JSX.Element => {
    const k = i++;
    const on = k === at;
    const st = c.group === 'sessions' && c.session ? STATUS[c.session.status] : undefined;
    // Options take no focus: the input keeps it and points here with aria-activedescendant, and
    // its keys (the arrows, Enter) are the keyboard path for the click.
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles the keys
      // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input
      <div
        key={`${c.group}:${c.id}`}
        id={`k-pal-o${k}`}
        role="option"
        aria-selected={on ? 'true' : 'false'}
        aria-disabled={c.disabled ? 'true' : undefined}
        class={on ? 'k-it k-pal-o on' : 'k-it k-pal-o'}
        onPointerMove={() => {
          if (!on) setActive(k);
        }}
        // Focus stays in the input.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(c)}
      >
        <span class="k-name">
          <Label c={c} hits={hits} />
        </span>
        {st ? (
          <span class={`k-pal-st${st[1]}`}>{st[0]}</span>
        ) : c.note ? (
          <span class="k-pal-st">{c.note}</span>
        ) : (
          c.key && <kbd>{c.key}</kbd>
        )}
      </div>
    );
  };

  return (
    <div class="k-pal" role="dialog" aria-modal="true" aria-label="Command palette" ref={panel}>
      <input
        ref={input}
        class="k-pal-in"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="k-pal-list"
        aria-autocomplete="list"
        aria-activedescendant={n > 0 ? `k-pal-o${at}` : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder="Jump to a session or run a command…"
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="k-pal-list" id="k-pal-list" role="listbox" aria-label="Results">
        {groups.map(({ g, rows }) => (
          // biome-ignore lint/a11y/useSemanticElements: a listbox's groups are role=group, not fieldsets
          <div role="group" aria-labelledby={groupId(g)} key={g}>
            <div class="k-g" id={groupId(g)} role="presentation">
              {g}
            </div>
            {rows.map(option)}
          </div>
        ))}
      </div>
      {/* Outside the listbox, which holds options only; the live region says the same. */}
      {n === 0 && (
        <div class="k-pal-none" aria-hidden="true">
          No matches.
        </div>
      )}
      {more && <div class="k-pal-more">Keep typing to see more.</div>}
      <div class="k-pal-foot">↑↓ to move · Enter to open · Esc to close</div>
      <div class="k-pal-live" role="status" aria-live="polite">
        {n === 0
          ? 'No matches.'
          : more
            ? `${LIMIT}+ results`
            : `${n} ${n === 1 ? 'result' : 'results'}`}
      </div>
    </div>
  );
}
