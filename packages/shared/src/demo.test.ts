import { describe, expect, it } from 'vitest';
import { demoSessions } from './demo.ts';
import { formatAge } from './format.ts';

const now = Date.UTC(2026, 10, 21, 14, 32);
const s = demoSessions(now);

describe('demoSessions', () => {
  it('has the six design sessions in order', () => {
    expect(s.map((x) => x.id)).toEqual(['web', 'shop', 'infra', 'rate', 'footer', 'docs']);
  });

  it('ports the web session', () => {
    const web = s.find((x) => x.id === 'web');
    expect(web).toMatchObject({
      status: 'needs-you',
      project: 'web',
      task: 'dark mode',
      branch: 'feat/dark-mode',
      worktree: '~/projects/web/.worktrees/dark-mode',
      question: { text: 'Which approach should I use?', options: ['CSS variables', 'Tailwind'] },
    });
    expect(formatAge(now - (web?.statusSince ?? 0))).toBe('4m');
    expect(formatAge(now - (web?.startedAt ?? 0))).toBe('18m');
  });

  it('marks rate pinned and done, and docs as one commit unpushed', () => {
    expect(s.find((x) => x.id === 'rate')).toMatchObject({ status: 'done', pinned: true });
    expect(s.find((x) => x.id === 'docs')).toMatchObject({ unpushed: 1 });
    expect(s.filter((x) => x.unpushed > 0).length).toBe(1);
  });

  it('ends shop with a thinking line', () => {
    expect(s.find((x) => x.id === 'shop')?.lines.at(-1)).toEqual({
      kind: 'think',
      text: 'Writing a regression test for the refresh case… (38s)',
    });
  });

  it('converts ports and files to typed values', () => {
    expect(s.find((x) => x.id === 'web')?.ports).toEqual([
      { port: 5173, process: 'vite', localOnly: false },
    ]);
    expect(s.find((x) => x.id === 'rate')?.files).toEqual([
      { path: 'src/middleware/rateLimit.ts', added: 86, removed: 0 },
      { path: 'test/rateLimit.test.ts', added: 64, removed: 0 },
    ]);
    expect(s.every((x) => !x.archived && !x.external)).toBe(true);
  });
});
