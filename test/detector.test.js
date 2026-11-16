'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject } = require('../electron/detector');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return dir;
}

test('npm 项目：识别 dev 脚本与 npm install', () => {
  const dir = project({
    'package.json': { scripts: { dev: 'vite' }, dependencies: { vite: '^5.0.0' } },
  });
  const result = detectProject(dir);
  assert.equal(result.runtime, 'Node.js');
  assert.equal(result.setupCommand, 'npm install');
  assert.equal(result.startCommand, 'npm run dev');
  assert.ok(result.notes.some((note) => note.includes('Vite')));
});

test('pnpm 项目：使用 pnpm install / pnpm run', () => {
  const dir = project({
    'package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '^14' } },
    'pnpm-lock.yaml': 'lockfileVersion: 9',
  });
  const result = detectProject(dir);
  assert.equal(result.setupCommand, 'pnpm install');
  assert.equal(result.startCommand, 'pnpm run dev');
});

test('没有 dev 脚本时回退到 start', () => {
  const dir = project({ 'package.json': { scripts: { start: 'node server.js' } } });
  const result = detectProject(dir);
  assert.equal(result.startCommand, 'npm run start');
});

test('Python requirements 项目', () => {
  const dir = project({ 'requirements.txt': 'flask\n', 'app.py': 'print(1)' });
  const result = detectProject(dir);
  assert.equal(result.runtime, 'Python');
  assert.equal(result.setupCommand, 'pip install -r requirements.txt');
  assert.equal(result.startCommand, 'python app.py');
});

test('Django manage.py 优先作为启动命令', () => {
  const dir = project({ 'requirements.txt': 'django\n', 'manage.py': '#!/usr/bin/env python' });
  const result = detectProject(dir);
  assert.equal(result.startCommand, 'python manage.py runserver');
});

test('Rust / Go / Docker / .NET 特征识别', () => {
  assert.equal(detectProject(project({ 'Cargo.toml': '[package]' })).startCommand, 'cargo run');
  assert.equal(detectProject(project({ 'go.mod': 'module x' })).startCommand, 'go run .');
  assert.equal(
    detectProject(project({ 'docker-compose.yml': 'services: {}' })).setupCommand,
    '',
  );
  assert.equal(detectProject(project({ 'app.csproj': '<Project />' })).startCommand, 'dotnet run');
});

test('未知目录返回提示而不是报错', () => {
  const dir = project({ 'notes.txt': 'hi' });
  const result = detectProject(dir);
  assert.equal(result.runtime, null);
  assert.equal(result.setupCommand, '');
  assert.equal(result.notes.length, 1);
});

test('目录不存在时抛错', () => {
  assert.throws(() => detectProject(path.join(os.tmpdir(), 'devdock-not-exist-xyz')), /目录不存在/);
});

test('setup.py 项目识别为 Python 并使用 pip install -e .', () => {
  const result = detectProject(project({ 'setup.py': 'from setuptools import setup' }));
  assert.equal(result.runtime, 'Python');
  assert.equal(result.setupCommand, 'pip install -e .');
});

test('requirements/base.txt 也能作为依赖清单', () => {
  const result = detectProject(project({ 'requirements/base.txt': 'flask\n' }));
  assert.equal(result.runtime, 'Python');
  assert.equal(result.setupCommand, 'pip install -r requirements/base.txt');
});

test('没有启动脚本时用 Procfile 的 web 进程', () => {
  const dir = project({
    'package.json': { name: 'demo' },
    'Procfile': 'web: node server.js\n',
  });
  const result = detectProject(dir);
  assert.equal(result.startCommand, 'node server.js');
  assert.ok(result.notes.some((note) => note.includes('Procfile')));
});

test('根目录没有清单时识别一层子项目（backend + web）', () => {
  const dir = project({
    'backend/requirements.txt': 'flask\n',
    'backend/app.py': 'print("hi")',
    'web/package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } },
  });
  const result = detectProject(dir);
  assert.equal(result.runtime, 'Multi-project');
  assert.equal(result.services.length, 2);
  const backend = result.services.find((service) => service.name === 'backend');
  const web = result.services.find((service) => service.name === 'web');
  assert.equal(backend.startCommand, 'python app.py');
  assert.equal(backend.cwd, 'backend');
  assert.equal(web.startCommand, 'npm run dev');
  assert.equal(web.role, 'frontend');
});
