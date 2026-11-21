import type { LineKind, Session } from '@kage/shared';
import { useLayoutEffect, useRef } from 'preact/hooks';

const PREFIX: Record<LineKind, string> = {
  tool: '',
  say: '',
  think: '',
  add: '+ ',
  del: '− ',
  out: '  ',
};

/** The transcript. It stays scrolled to the bottom unless the reader has scrolled up. */
export function Output({ session }: { session: Session }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shownId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shownId.current !== session.id || stick.current) el.scrollTop = el.scrollHeight;
    shownId.current = session.id;
  });
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return (
    <div class="k-tr" ref={ref} onScroll={onScroll}>
      {session.lines.map((l, i) => (
        <div class={`ln ln-${l.kind}`} key={i}>
          {PREFIX[l.kind] ?? ''}
          {l.text}
          {l.kind === 'tool' && l.detail !== undefined && (
            <>
              {' '}
              <span class="dim">{l.detail}</span>
            </>
          )}
        </div>
      ))}
      {session.status === 'running' && <span class="cursor" />}
    </div>
  );
}
