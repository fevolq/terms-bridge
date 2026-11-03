import test from 'node:test';
import assert from 'node:assert/strict';
import { queued, beginExecution, executionFailed, completed, beginDelivery, deliveryFinished } from '../dist/domain/task.js';
import { recordSchema } from '../dist/storage/tasks.js';
import { request, project } from './helpers.mjs';

const now = Date.parse('2026-11-02T08:00:00Z');
test('state transitions retain the admission snapshot and exhaust retries with distinct sessions', () => {
  const input = request(), config = project({ max_execution_retries: 1 });
  let task = queued(input, config, [], now);
  input.instruction = 'changed'; config.max_execution_retries = 10;
  assert.equal(task.project.max_execution_retries, 1);
  assert.equal(task.request.instruction, 'Summarize input.');
  const history = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const previous = structuredClone(task), original = task;
    task = beginExecution(task); recordSchema.parse(task);
    assert.deepEqual(original, previous);
    history.push(task.execution.session_id);
    task = executionFailed(task, task.execution.attempt_id, 'EXECUTION_ERROR', now); recordSchema.parse(task);
    assert.equal(task.status, attempt === 1 ? 'retrying' : 'failed');
  }
  assert.equal(new Set(history).size, 2);
  assert.throws(() => beginExecution(task), /not runnable/);
});

test('callback retries retain the exact final text and never alter execution attempts', () => {
  let task = beginExecution(queued(request(), project(), [], now));
  const text = '原文\n\n[结果](a.png)  ';
  task = completed(task, task.execution.attempt_id, { result: text, files: [] }, now);
  const body = task.callback_body;
  for (let attempt = 1; attempt <= 11; attempt++) {
    task = beginDelivery(task); recordSchema.parse(task);
    task = deliveryFinished(task, 'HTTP 503', now); recordSchema.parse(task);
    assert.equal(task.execution.attempts, 1);
    assert.equal(task.callback_body, body);
    assert.equal(task.result, text);
    assert.equal(task.delivery.status, attempt === 11 ? 'failed' : 'retrying');
    assert.equal(task.delivery.next_retry_at, attempt === 11 ? null : new Date(now + 60_000).toISOString());
  }
  assert.equal(beginDelivery(task).delivery.attempts, 11);
});
