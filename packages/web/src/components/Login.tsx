import { useEffect, useRef, useState } from 'preact/hooks';
import { login } from '../api.ts';
import { connect } from '../sse.ts';
import { authRequired } from '../store.ts';

const ERRORS = {
  wrong: "That token isn't right.",
  limited: 'Too many tries. Wait a minute and try again.',
  error: "Couldn't reach Kage. Try again.",
} as const;

/** The login screen (spec §5.10): shown while the server answers 401. */
export function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The token is the only thing to do here.
  useEffect(() => field.current?.focus(), []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || token === '') return;
    setBusy(true);
    const result = await login(token);
    setBusy(false);
    if (result === 'ok') {
      authRequired.value = false;
      connect();
      return;
    }
    setError(ERRORS[result]);
  };

  return (
    <main class="k-main">
      <form class="k-login" onSubmit={submit}>
        <p>This Kage needs its access token.</p>
        <input
          ref={field}
          class="k-follow"
          type="password"
          placeholder="Access token"
          autocomplete="current-password"
          aria-label="Access token"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <button class="k-act" type="submit" disabled={busy}>
          Sign in
        </button>
        {error && (
          <p class="k-login-err" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
