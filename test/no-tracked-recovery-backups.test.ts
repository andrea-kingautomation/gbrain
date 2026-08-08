import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const RECOVERY_BACKUP = /(^|\/)\S+\.bak(?:[._-]|$)/;

describe('repository packaging hygiene', () => {
  test('no local recovery backup files are tracked', () => {
    const result = spawnSync('git', ['ls-files'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const offenders = result.stdout
      .split('\n')
      .filter(Boolean)
      .filter((path) => RECOVERY_BACKUP.test(path));
    expect(offenders).toEqual([]);
  });
});
