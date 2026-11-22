import { LIMITS, type Port, type Session } from '@kage/shared';
import { mainView } from '../store.ts';

const label = (p: Port) => (
  <span>
    :{p.port} <span class="dim">{p.process}</span>
  </span>
);

/** The board opened on the machine itself: loopback-only ports are reachable from here. */
const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * A port's card (spec §5.7). It links to the port on the host this board was opened from; a port
 * that listens only on loopback can't be reached that way from elsewhere, so its card shows the
 * tunnel to run.
 */
function PortCard({ port: p }: { port: Port }) {
  const host = location.hostname;
  if (!p.localOnly || LOCAL.includes(host)) {
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

/**
 * Files changed (spec §5.7): at most LIMITS.files rows, whatever the server sent (B28), then
 * "and N more". No files: a line and no View diff. An external window has no branch of Kage's:
 * its list is the folder's work against HEAD, and when that is empty (or no repository) one line
 * says why in place of the section.
 */
function FilesSection({ session }: { session: Session }) {
  if (session.external && session.filesTotal === 0) {
    return (
      <div class="k-sec">
        <h4>Files changed</h4>
        <div class="k-none">Kage didn't start this window, so there's no branch to compare.</div>
      </div>
    );
  }
  const files = session.files.slice(0, LIMITS.files);
  const more = session.filesTotal - files.length;
  return (
    <div class="k-sec">
      <h4>Files changed · {session.filesTotal}</h4>
      {session.filesTotal === 0 && <div class="k-none">No files changed yet.</div>}
      {files.map((f) => (
        <div class="k-file" key={f.path}>
          <span class="p" title={f.path}>
            {f.path}
          </span>
          <span class="a">+{f.added}</span>
          <span class="r">−{f.removed}</span>
        </div>
      ))}
      {more > 0 && <div class="k-more">and {more} more</div>}
      {session.filesTotal > 0 && (
        <button
          type="button"
          class="k-diff"
          aria-expanded={mainView.value === 'diff' ? 'true' : 'false'}
          aria-controls={mainView.value === 'diff' ? 'k-diff-view' : undefined}
          onClick={() => {
            mainView.value = 'diff';
          }}
        >
          View diff →
        </button>
      )}
    </div>
  );
}

export function PreviewPane({ session }: { session: Session }) {
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
      <FilesSection session={session} />
    </aside>
  );
}
