'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectWorkspaces, detectProject } = require('../electron/detector');

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-ws-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return dir;
}

test('pnpm workspace 识别前后端两个服务', () => {
  const dir = makeProject({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' }, dependencies: { react: '^18' } },
    'apps/api/package.json': { name: 'api', scripts: { dev: 'nest start --watch' }, dependencies: { '@nestjs/core': '^10' } },
  });

  const services = detectWorkspaces(dir);
  assert.equal(services.length, 2);

  const web = services.find((service) => service.id === 'web');
  const api = services.find((service) => service.id === 'api');
  assert.equal(web.role, 'frontend');
  assert.equal(web.cwd, path.join('apps', 'web'));
  assert.equal(api.role, 'backend');
});

test('根 package.json 的 workspaces 字段也能识别', () => {
  const dir = makeProject({
    'package.json': { name: 'root', workspaces: ['packages/*'] },
    'packages/client/package.json': { name: 'client', scripts: { dev: 'vite' } },
    'packages/server/package.json': { name: 'server', scripts: { start: 'node index.js' } },
  });

  const services = detectWorkspaces(dir);
  assert.deepEqual(services.map((service) => service.id).sort(), ['client', 'server']);
  assert.equal(services.find((service) => service.id === 'client').role, 'frontend');
  assert.equal(services.find((service) => service.id === 'server').role, 'backend');
});

test('名称没有关键词时按依赖推断角色', () => {
  const dir = makeProject({
    'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
    'services/site/package.json': { name: 'site', scripts: { dev: 'vite' }, dependencies: { react: '^18' } },
    'services/gateway/package.json': { name: 'gateway', scripts: { dev: 'tsx src/index.ts' }, dependencies: { express: '^4' } },
  });

  const services = detectWorkspaces(dir);
  assert.equal(services.find((service) => service.id === 'site').role, 'frontend');
  assert.equal(services.find((service) => service.id === 'gateway').role, 'backend');
});

test('workspace 里的启动命令使用对应的包管理器', () => {
  const dir = makeProject({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' } },
  });

  const services = detectWorkspaces(dir);
  assert.equal(services[0].startCommand, 'pnpm run dev');
});

test('workspace 目录缺失时跳过而不是报错', () => {
  const dir = makeProject({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' } },
  });

  const services = detectWorkspaces(dir);
  assert.equal(services.length, 1);
});

test('没有 workspace 配置时返回空列表', () => {
  const dir = makeProject({ 'package.json': { name: 'plain' } });
  assert.deepEqual(detectWorkspaces(dir), []);
});

test('detectProject 用 workspace 服务替换单一主服务', () => {
  const dir = makeProject({
    'package.json': { name: 'root', workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' } },
    'apps/api/package.json': { name: 'api', scripts: { dev: 'node server.js' } },
  });

  const result = detectProject(dir);
  assert.equal(result.services.length, 2);
  assert.equal(result.services.some((service) => service.id === 'main'), false);
});

test('workspace 与 compose 数据库合并时数据库优先且被依赖', () => {
  const dir = makeProject({
    'package.json': { name: 'root', workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' } },
    'apps/api/package.json': { name: 'api', scripts: { dev: 'node server.js' } },
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
  });

  const result = detectProject(dir);
  assert.equal(result.services[0].id, 'db');
  assert.equal(result.services[0].role, 'database');

  const api = result.services.find((service) => service.id === 'api');
  assert.ok(api.dependsOn.includes('db'));
});
