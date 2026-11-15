'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, normalizeState } = require('../electron/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-store-'));
}

test('空目录返回空状态', () => {
  const store = new Store(tmpDir());
  assert.deepEqual(store.list(), []);
  assert.equal(store.getState().activeId, null);
});

test('保存并持久化项目档案', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const saved = store.saveProfile({
    name: 'demo',
    dir: 'D:\\code\\demo',
    setupCommand: 'npm install',
    startCommand: 'npm run dev',
    envVars: [{ key: 'NODE_ENV', value: 'development' }],
  });

  assert.ok(saved.id);
  assert.equal(saved.shell, 'cmd');
  assert.equal(store.list().length, 1);

  const reloaded = new Store(dir);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].startCommand, 'npm run dev');
});

test('更新同一个 id 不会新增档案', () => {
  const store = new Store(tmpDir());
  const first = store.saveProfile({ name: 'a', dir: 'D:\\a' });
  const second = store.saveProfile({ id: first.id, name: 'b', dir: 'D:\\b' });
  assert.equal(store.list().length, 1);
  assert.equal(second.name, 'b');
  assert.equal(second.createdAt, first.createdAt);
});

test('切换活跃项目并清理删除后的引用', () => {
  const store = new Store(tmpDir());
  const a = store.saveProfile({ name: 'a', dir: 'D:\\a' });
  const b = store.saveProfile({ name: 'b', dir: 'D:\\b' });

  store.setActive(a.id);
  assert.equal(store.getState().activeId, a.id);
  store.setActive(b.id);
  assert.equal(store.getState().activeId, b.id);

  store.remove(b.id);
  assert.equal(store.getState().activeId, null);
  assert.equal(store.list().length, 1);
});

test('损坏的 profiles.json 会备份并回退为空状态', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{ 这不是 JSON', 'utf8');
  const store = new Store(dir);
  assert.deepEqual(store.list(), []);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('corrupt-'));
  assert.equal(backups.length, 1);
});

test('normalizeState 过滤非法档案并修正 activeId', () => {
  const state = normalizeState({
    profiles: [{ dir: 'D:\\ok' }, { name: 'no-dir' }, null],
    activeId: 'ghost',
    setupAt: { ghost: 1 },
  });
  assert.equal(state.profiles.length, 1);
  assert.equal(state.activeId, null);
  assert.deepEqual(state.setupAt, {});
});

test('markSetup 记录环境搭建时间', () => {
  const store = new Store(tmpDir());
  const profile = store.saveProfile({ dir: 'D:\\a' });
  assert.equal(store.isSetup(profile.id), false);
  store.markSetup(profile.id);
  assert.equal(store.isSetup(profile.id), true);
});
