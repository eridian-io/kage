import type { Port, Session } from '@kage/shared';
import { INERT } from './inert.ts';

const label = (p: Port) => (
  <span>
    :{p.port} <span class="dim">{p.process}</span>
  </span>
);

/**
 * A port's card (spec §5.7). It links to the port on the host this board was opened from; a port
 * that listens only on loopback can't be reached that way, so its card shows the tunnel to run.
 */
function PortCard({ port: p }: { port: Port }) {
  const host = location.hostname;
  if (!p.localOnly) {
    return (
      <a
        class="k-port"
        href={`http://${host}:${p.port}/`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {label(p)}
        <span class="go">Open ↗</span>
      </a>
    );
  }
  return (
    <>
      <div class="k-port local">
        {label(p)}
        <span class="only">Only on this machine</span>
      </div>
      <div class="k-ssh" title={`Run this on your laptop, then open http://localhost:${p.port}`}>
        {/* An IPv6 host comes bracketed for URLs; ssh takes it bare. */}
        {`ssh -L ${p.port}:localhost:${p.port} ${host.replace(/^\[|\]$/g, '')}`}
      </div>
    </>
  );
}

export function PreviewPane({ session }: { session: Session }) {
  const more = session.filesTotal - session.files.length;
  return (
    <aside class="k-aside">
      <div class="k-sec">
        <h4>Preview</h4>
        {session.ports.length > 0 ? (
          session.ports.map((p) => <PortCard port={p} key={p.port} />)
        ) : (
          <div class="k-none">No ports open yet.</div>
        )}
      </div>
      <div class="k-sec">
        <h4>Files changed · {session.filesTotal}</h4>
        {session.files.map((f) => (
          <div class="k-file" key={f.path}>
            <span class="p" title={f.path}>
              {f.path}
            </span>
            <span class="a">+{f.added}</span>
            <span class="r">−{f.removed}</span>
          </div>
        ))}
        {more > 0 && <div class="k-more">and {more} more</div>}
        <div class="k-diff" {...INERT}>
          View diff →
        </div>
      </div>
    </aside>
  );
}
