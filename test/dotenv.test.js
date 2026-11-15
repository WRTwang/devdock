'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('../electron/dotenv');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-env-'));
}

test('原本没有 .env：写入后停止会删除', () => {
  const dir = tmpProject();
  const file = path.join(dir, '.env');

  const applied = dotenv.apply(dir, [{ key: 'API_URL', value: 'http://localhost:3000' }]);
  assert.equal(applied.applied, true);
  assert.equal(applied.existed, false);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'API_URL=http://localhost:3000');
  assert.equal(fs.existsSync(path.join(dir, dotenv.BACKUP_FILE)), false);

  const restored = dotenv.restore(dir);
  assert.equal(restored.restored, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(dir, dotenv.STATE_FILE)), false);
});

test('原本有 .env：保留原内容并在还原后完全恢复', () => {
  const dir = tmpProject();
  const file = path.join(dir, '.env');
  const original = '# 注释保留\nDEBUG=false\nTOKEN=abc\n';
  fs.writeFileSync(file, original, 'utf8');

  dotenv.apply(dir, [
    { key: 'DEBUG', value: 'true' },
    { key: 'API_URL', value: 'http://localhost:8080' },
  ]);

  const merged = fs.readFileSync(file, 'utf8');
  assert.match(merged, /# 注释保留/);
  assert.match(merged, /DEBUG=true/);
  assert.match(merged, /TOKEN=abc/);
  assert.match(merged, /API_URL=http:\/\/localhost:8080/);

  dotenv.restore(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, dotenv.BACKUP_FILE)), false);
});

test('重复 apply 不会覆盖原始备份', () => {
  const dir = tmpProject();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=1\n', 'utf8');

  dotenv.apply(dir, [{ key: 'A', value: '2' }]);
  dotenv.apply(dir, [{ key: 'A', value: '3' }]);
  dotenv.restore(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\n');
});

test('没有状态文件时 restore 是空操作', () => {
  const dir = tmpProject();
  assert.deepEqual(dotenv.restore(dir), { restored: false, existed: false });
});

test('特殊字符值会被引号包裹', () => {
  const text = dotenv.mergeEnvText('', [{ key: 'GREETING', value: 'hello world' }]);
  assert.equal(text.trim(), 'GREETING="hello world"');
});

test('toProcessEnv 不修改原始环境对象', () => {
  const base = { PATH: 'x' };
  const env = dotenv.toProcessEnv(base, [{ key: 'NODE_ENV', value: 'development' }]);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(base.NODE_ENV, undefined);
});
