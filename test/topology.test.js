'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sortServices } = require('../electron/services');

function svc(id, dependsOn = []) {
  return { id, name: id, role: 'app', dependsOn };
}

test('无依赖时保持输入顺序', () => {
  const { order, cycle } = sortServices([svc('web'), svc('api'), svc('db')]);
  assert.equal(cycle, null);
  assert.deepEqual(order.map((service) => service.id), ['web', 'api', 'db']);
});

test('线性依赖按数据库 → 后端 → 前端排序', () => {
  const { order, cycle } = sortServices([svc('web', ['api']), svc('api', ['db']), svc('db')]);
  assert.equal(cycle, null);
  assert.deepEqual(order.map((service) => service.id), ['db', 'api', 'web']);
});

test('并行分支保持各自的相对顺序', () => {
  const { order } = sortServices([
    svc('web', ['api']),
    svc('worker', ['db']),
    svc('api', ['db']),
    svc('db'),
  ]);
  assert.deepEqual(order.map((service) => service.id), ['db', 'worker', 'api', 'web']);
});

test('自依赖判定为环', () => {
  const { order, cycle } = sortServices([svc('db', ['db'])]);
  assert.deepEqual(order, []);
  assert.deepEqual(cycle, ['db']);
});

test('双向依赖判定为环并列出全部节点', () => {
  const { order, cycle } = sortServices([svc('api', ['web']), svc('web', ['api'])]);
  assert.deepEqual(order, []);
  assert.deepEqual(cycle.sort(), ['api', 'web']);
});

test('环存在时不返回部分顺序', () => {
  const { order, cycle } = sortServices([svc('db'), svc('api', ['db', 'web']), svc('web', ['api'])]);
  assert.deepEqual(order, []);
  assert.deepEqual(cycle.sort(), ['api', 'web']);
});

test('未知依赖 id 被忽略', () => {
  const { order, cycle } = sortServices([svc('api', ['missing']), svc('web')]);
  assert.equal(cycle, null);
  assert.deepEqual(order.map((service) => service.id), ['api', 'web']);
});

test('重复依赖只计一次', () => {
  const { order, cycle } = sortServices([svc('api', ['db', 'db']), svc('db')]);
  assert.equal(cycle, null);
  assert.deepEqual(order.map((service) => service.id), ['db', 'api']);
});

test('空列表返回空顺序', () => {
  assert.deepEqual(sortServices([]), { order: [], cycle: null });
  assert.deepEqual(sortServices(null), { order: [], cycle: null });
});
