import { describe, expect, it } from 'vitest';
import { couldnt } from './copy.ts';

describe('couldnt', () => {
  it('joins the action and the sentence with a full stop', () => {
    expect(couldnt('delete', 'The branch changed since you looked.')).toBe(
      "Couldn't delete. The branch changed since you looked.",
    );
  });
  it('raises a lower-case first letter and keeps the rest as sent', () => {
    expect(couldnt('load the diff', "git couldn't show the diff: the folder is gone.")).toBe(
      "Couldn't load the diff. Git couldn't show the diff: the folder is gone.",
    );
  });
});
