'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterChunks, summarizeServices } = require('../renderer/log-filter');

const CHUNKS = [
  { serviceId: 'db', stream: 'stdout', text: 'postgres ready' },
  { serviceId: 'api', stream: 'stdout', text: 'api listening' },
  { serviceId: 'api', stream: 'stderr', text: 'warn' },
];

test('不筛选时返回全部日志', () => {
  assert.equal(filterChunks(CHUNKS, null).length, 3);
  assert.equal(filterChunks(CHUNKS, '').length, 3);
});

test('按服务过滤日志', () => {
  const result = filterChunks(CHUNKS, 'api');
  assert.equal(result.length, 2);
  assert.ok(result.every((chunk) => chunk.serviceId === 'api'));
});

test('缺少 serviceId 的历史日志归到 main', () => {
  const result = filterChunks([{ stream: 'stdout', text: 'legacy' }], 'main');
  assert.equal(result.length, 1);
  assert.equal(result[0].serviceId, 'main');
});

test('summarizeServices 合并运行状态', () => {
  const services = [
    { id: 'db', name: 'PostgreSQL', role: 'database', port: 5432 },
    { id: 'api', name: 'API', role: 'backend', port: 4000 },
  ];
  const summary = summarizeServices(services, { services: ['api'], running: true });
  assert.equal(summary[0].running, false);
  assert.equal(summary[1].running, true);
});

test('没有运行状态时全部为未运行', () => {
  const summary = summarizeServices([{ id: 'a', name: 'A' }], null);
  assert.equal(summary[0].running, false);
});

test('服务名缺省时回落到 id', () => {
  const summary = summarizeServices([{ id: 'worker' }], null);
  assert.equal(summary[0].name, 'worker');
});
