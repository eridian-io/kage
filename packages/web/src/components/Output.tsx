import type { DisplayLine, LineKind, Session } from '@kage/shared';
import { Component } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { lineKeyBase, linesById, MAX_LINES } from '../store.ts';

const PREFIX: Record<LineKind, string> = {
  tool: '',
  say: '',
  think: '',
  add: '+ ',
  del: '− ',
  out: '  ',
};

/**
 * One output line. Lines never change once they arrive, so a line re-renders only when it is a
 * different line object: appending to a long transcript touches the new nodes alone.
 */
class Line extends Component<{ line: DisplayLine }> {
  override shouldComponentUpdate(next: { line: DisplayLine }): boolean {
    return next.line !== this.props.line;
  }
  override render() {
    const l = this.props.line;
    return (
      <div class={`ln ln-${l.kind}`}>
        {PREFIX[l.kind] ?? ''}
        {l.text}
        {l.kind === 'tool' && l.detail !== undefined && (
          <>
            {' '}
            <span class="dim">{l.detail}</span>
          </>
        )}
      </div>
    );
  }
}

/**
 * The transcript, newest 500 lines. Each line is keyed by its place in everything the session
 * has sent, so new lines are appended and dropped ones removed without touching the rest. It stays
 * scrolled to the bottom unless the reader has scrolled up.
 */
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
  const held = linesById.value.get(session.id) ?? [];
  const skip = Math.max(0, held.length - MAX_LINES);
  const base = lineKeyBase(session.id, held.length) + skip;
  const running = session.status === 'running';
  // The "now doing" line stands in for the think line until the transcript has its own.
  const nowLine = running && session.now && held.at(-1)?.kind !== 'think' ? session.now : null;
  return (
    <div class="k-tr" ref={ref} onScroll={onScroll}>
      {held.slice(skip).map((l, i) => (
        <Line line={l} key={base + i} />
      ))}
      {nowLine !== null && (
        <div class="ln ln-think" key="now">
          {nowLine}
        </div>
      )}
      {running && <span class="cursor" />}
    </div>
  );
}
