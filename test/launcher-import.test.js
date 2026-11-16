'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotToProfile } = require('../electron/linker');

const SNAPSHOT = {
  version: 1,
  id: 'snap-1',
  name: 'shop',
  dir: 'D:\\code\\shop',
  shell: 'powershell',
  envVars: [{ key: 'NODE_ENV', value: 'development' }],
  services: [
    { id: 'db', name: 'PostgreSQL', role: 'database', cwd: '.', startCommand: 'docker compose up -d db', port: 5432, dependsOn: [] },
    { id: 'api', name: 'API', role: 'backend', cwd: 'server', startCommand: 'npm run start:dev', port: 4000, dependsOn: ['db'] },
  ],
  autoSetup: true,
  syncDotEnv: false,
  exportedAt: 1700000000000,
};

test('快照转换为可保存的档案输入', () => {
  const profile = snapshotToProfile(SNAPSHOT, 'D:\\code\\shop');
  assert.equal(profile.name, 'shop');
  assert.equal(profile.shell, 'powershell');
  assert.equal(profile.services.length, 2);
  assert.equal(profile.dir, 'D:\\code\\shop');
  assert.equal(profile.linkLauncher, true);
});

test('已存在同目录项目时沿用原 id', () => {
  const profile = snapshotToProfile(SNAPSHOT, 'D:\\code\\shop', 'existing-id');
  assert.equal(profile.id, 'existing-id');
});

test('导入时使用实际目录而不是快照里的旧路径', () => {
  const profile = snapshotToProfile(SNAPSHOT, 'E:\\moved\\shop');
  assert.equal(profile.dir, 'E:\\moved\\shop');
});

test('非法快照返回 null', () => {
  assert.equal(snapshotToProfile(null, 'D:\\x'), null);
  assert.equal(snapshotToProfile({}, 'D:\\x'), null);
  assert.equal(snapshotToProfile({ name: 'x' }, ''), null);
});
