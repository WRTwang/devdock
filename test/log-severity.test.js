'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClassifier, splitLines } = require('../renderer/log-severity');

test('Django 的 stderr 启动信息不再标红', () => {
  const classify = createClassifier();
  const lines = [
    'Watching for file changes with StatReloader',
    'Performing system checks...',
    '',
    'System check identified no issues (0 silenced).',
    'Starting development server at http://0.0.0.0:8001/',
    'Quit the server with CTRL-BREAK.',
  ];
  for (const line of lines) {
    assert.equal(classify('stderr', line), '', line);
  }
});

test('真正的错误仍然标红', () => {
  const classify = createClassifier();
  assert.equal(classify('stderr', 'django.db.utils.OperationalError: could not connect'), 'line-stderr');
  assert.equal(classify('stderr', 'Error: listen EADDRINUSE: address already in use :::8001'), 'line-stderr');
  assert.equal(classify('stderr', '拒绝访问。'), 'line-stderr');
});

test('警告标黄', () => {
  const classify = createClassifier();
  assert.equal(classify('stderr', 'DeprecationWarning: datetime.utcnow() is deprecated'), 'line-warn');
  assert.equal(classify('stderr', 'WARNING: settings module not found'), 'line-warn');
});

test('Traceback 连续行保持红色，空行后恢复', () => {
  const classify = createClassifier();
  assert.equal(classify('stderr', 'Traceback (most recent call last):'), 'line-stderr');
  assert.equal(classify('stderr', '  File "app.py", line 3, in <module>'), 'line-stderr');
  assert.equal(classify('stderr', '    raise ValueError'), 'line-stderr');
  assert.equal(classify('stderr', 'ValueError: boom'), 'line-stderr');
  assert.equal(classify('stderr', ''), '');
  assert.equal(classify('stderr', 'Watching for file changes with StatReloader'), '');
});

test('stdout 不因为出现 error 字样就标红', () => {
  const classify = createClassifier();
  assert.equal(classify('stdout', 'loaded error handler module'), '');
  assert.equal(classify('meta', 'process exited'), 'line-meta');
  assert.equal(classify('system', 'note'), 'line-system');
});

test('splitLines 保留空行用于重置状态', () => {
  assert.deepEqual(splitLines('a\n\nb\n'), ['a', '', 'b', '']);
});
