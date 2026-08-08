import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const source = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('archived source active-operation boundary', () => {
  test('automatic sync excludes archived source paths', () => {
    expect(source('src/commands/sync.ts')).toContain(
      'FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE',
    );
  });

  test('automatic source resolution excludes archived local paths', () => {
    const text = source('src/core/source-resolver.ts');
    expect(
      text.match(/SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE/g),
    ).toHaveLength(2);
  });

  test('automatic file maintenance excludes archived local paths', () => {
    expect(source('src/core/brain-writer.ts')).toContain(
      'FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id',
    );
    expect(source('src/commands/frontmatter-install-hook.ts')).toContain(
      'FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id',
    );
    expect(source('src/commands/sources-harden.ts')).toContain(
      'FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id',
    );
  });

  test('doctor freshness, drift, and filesystem checks exclude archived sources', () => {
    const text = source('src/commands/doctor.ts');
    expect(text).toContain(
      'SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE',
    );
    expect(
      text.match(/SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE/g),
    ).toHaveLength(2);
    expect(
      text.match(/SELECT id, local_path FROM sources WHERE archived IS NOT TRUE/g),
    ).toHaveLength(2);
  });
});
