import type { Session } from '@kage/shared';
import { INERT } from './inert.ts';

export function PreviewPane({ session }: { session: Session }) {
  return (
    <aside class="k-aside">
      <div class="k-sec">
        <h4>Preview</h4>
        {session.ports.length > 0 ? (
          session.ports.map((p) => (
            <div class="k-port" key={p.port} {...INERT}>
              <span>
                :{p.port} <span class="dim">{p.process}</span>
              </span>
              <span class="go">Open ↗</span>
            </div>
          ))
        ) : (
          <div class="k-none">No ports open yet.</div>
        )}
      </div>
      <div class="k-sec">
        <h4>Files changed · {session.files.length}</h4>
        {session.files.map((f) => (
          <div class="k-file" key={f.path}>
            <span class="p" title={f.path}>
              {f.path}
            </span>
            <span class="a">+{f.added}</span>
            <span class="r">−{f.removed}</span>
          </div>
        ))}
        <div class="k-diff" {...INERT}>
          View diff →
        </div>
      </div>
    </aside>
  );
}
