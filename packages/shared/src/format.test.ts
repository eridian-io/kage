import { describe, expect, it } from 'vitest';
import { formatAge, shortWorktree } from './format.ts';

describe('formatAge', () => {
  it('formats now, minutes, hours and days', () => {
    expect(formatAge(59_000)).toBe('now');
    expect(formatAge(4 * 60_000)).toBe('4m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(2 * 86_400_000)).toBe('2d');
  });
});

describe('shortWorktree', () => {
  it('strips ~/projects/ and a given root', () => {
    expect(shortWorktree('~/projects/web/.worktrees/dark-mode')).toBe('web/.worktrees/dark-mode');
    expect(shortWorktree('/srv/code/api/.worktrees/x', '/srv/code')).toBe('api/.worktrees/x');
  });
});
