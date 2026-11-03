import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../dist/domain/request.js';
import { request } from './helpers.mjs';

test('request accepts only metadata IDs, instruction and files; no old protocol', () => {
  const value = request(); assert.deepEqual(validateRequest(value), value);
  for (const extra of ['input', 'result_schema', 'context']) {
    assert.throws(() => validateRequest({ ...value, [extra]: {} }));
    assert.throws(() => validateRequest({ ...value, metadata: { ...value.metadata, [extra]: {} } }));
  }
  for (const field of ['metadata', 'instruction', 'files']) {
    const invalid = structuredClone(value); delete invalid[field]; assert.throws(() => validateRequest(invalid));
  }
  for (const instruction of ['', '  ', 'x'.repeat(32769), 1]) assert.throws(() => validateRequest({ ...value, instruction }));
  for (const metadata of [{ project_id: '../x', task_id: 'ok' }, { project_id: 'news', task_id: '../x' }]) assert.throws(() => validateRequest({ ...value, metadata }));
});

test('file references are ordered, bounded and unique', () => {
  const files = ['a', 'b'].map(c => ({ file_id: 'file_' + c.repeat(32) }));
  assert.deepEqual(validateRequest({ ...request(), files }).files, files);
  for (const invalid of [null, {}, [files[0], files[0]], [{ file_id: '../x' }], [{ ...files[0], path: 'x' }], Array(21).fill(files[0])]) {
    assert.throws(() => validateRequest({ ...request(), files: invalid }));
  }
});
