'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProject } = require('../electron/detector');

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-priority-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return dir;
}

test('README 的启动命令优先于 package.json', () => {
  const dir = makeProject({
    'package.json': { scripts: { start: 'node server.js' } },
    'README.md': '# App\n\n```bash\npnpm install\npnpm dev\n```\n',
  });

  const result = detectProject(dir);
  assert.equal(result.startCommand, 'pnpm dev');
  assert.equal(result.setupCommand, 'pnpm install');
  assert.equal(result.sources.start, 'readme');
});

test('README 只有安装命令时，启动命令仍用结构推断', () => {
  const dir = makeProject({
    'package.json': { scripts: { dev: 'vite' } },
    'README.md': '# App\n\n```bash\nnpm ci\n```\n',
  });

  const result = detectProject(dir);
  assert.equal(result.setupCommand, 'npm ci');
  assert.equal(result.startCommand, 'npm run dev');
  assert.equal(result.sources.setup, 'readme');
  assert.equal(result.sources.start, 'structure');
});

test('README 的端口填给主服务', () => {
  const dir = makeProject({
    'package.json': { scripts: { dev: 'vite' } },
    'README.md': '# App\n\n```bash\nnpm run dev\n```\n\n访问 http://localhost:5173\n',
  });

  const result = detectProject(dir);
  const main = result.services.find((service) => service.id === 'main');
  assert.equal(main.port, 5173);
});

test('多服务项目不被 README 整体命令覆盖', () => {
  const dir = makeProject({
    'package.json': { name: 'root', workspaces: ['apps/*'] },
    'apps/web/package.json': { name: 'web', scripts: { dev: 'vite' } },
    'apps/api/package.json': { name: 'api', scripts: { dev: 'node server.js' } },
    'README.md': '# Monorepo\n\n```bash\nnpm run dev\n```\n',
  });

  const result = detectProject(dir);
  const web = result.services.find((service) => service.id === 'web');
  const api = result.services.find((service) => service.id === 'api');
  assert.equal(web.startCommand, 'npm run dev');
  assert.equal(api.startCommand, 'npm run dev');
  assert.ok(result.notes.some((note) => note.includes('README')));
});

test('没有 README 时 sources 全部为 structure', () => {
  const dir = makeProject({ 'package.json': { scripts: { dev: 'vite' } } });
  const result = detectProject(dir);
  assert.equal(result.sources.setup, 'structure');
  assert.equal(result.sources.start, 'structure');
});

test('README 只在 noise 时不覆盖结构命令', () => {
  const dir = makeProject({
    'package.json': { scripts: { dev: 'vite' } },
    'README.md': '# App\n\n```bash\ngit clone https://example.com/x.git\n```\n',
  });

  const result = detectProject(dir);
  assert.equal(result.startCommand, 'npm run dev');
  assert.equal(result.sources.start, 'structure');
});
