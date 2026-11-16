'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../electron/tools');
const dbstart = require('../electron/dbstart');
const envcheck = require('../electron/envcheck');

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-envcheck-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** 可控的 exec 桩：按可执行文件名返回版本，其余命令统一失败。 */
function fakeExec(overrides = {}) {
  return async (file, args = []) => {
    const key = `${file} ${args.join(' ')}`.trim();
    if (overrides[key]) {
      const value = overrides[key];
      return typeof value === 'string' ? { ok: true, stdout: value, stderr: '', error: null } : value;
    }
    if (overrides[file]) {
      const value = overrides[file];
      return typeof value === 'string' ? { ok: true, stdout: value, stderr: '', error: null } : value;
    }
    if (file === 'sc') return { ok: true, stdout: '', stderr: '', error: null };
    return { ok: false, stdout: '', stderr: '', error: `未找到 ${file}` };
  };
}

const NODE_OK = fakeExec({ node: 'v20.11.1', npm: '10.2.4' });
const NODE_MISSING = fakeExec({ npm: '10.2.4' });

test('parseVersion 兼容 v 前缀与 Python 输出', () => {
  assert.deepEqual(tools.parseVersion('v20.11.1'), [20, 11, 1]);
  assert.deepEqual(tools.parseVersion('Python 3.13.2'), [3, 13, 2]);
  assert.equal(tools.parseVersion('not a version'), null);
});

test('meetsMinimum 比较主次版本', () => {
  assert.equal(tools.meetsMinimum('20.0.1', '18.0.0'), true);
  assert.equal(tools.meetsMinimum('16.20.2', '18.0.0'), false);
  assert.equal(tools.meetsMinimum(null, '18.0.0'), false);
});

test('probeTool 依次尝试候选解释器', async () => {
  const exec = async (file) => {
    if (file === 'python') return { ok: false, error: 'App execution alias' };
    return { ok: true, stdout: 'Python 3.12.4', stderr: '' };
  };
  const result = await tools.probeTool('python', { exec });
  assert.equal(result.found, true);
  assert.equal(result.version, '3.12.4');
  assert.equal(result.ok, true);
});

test('acquirePlan 对未知工具返回 null', () => {
  assert.equal(tools.acquirePlan('unknown'), null);
  const plan = tools.acquirePlan('node', '16.0.0');
  assert.equal(plan.needsConsent, true);
  assert.match(plan.title, /升级/);
});

test('Node 项目：node_modules 存在时标记为 ok', async () => {
  const dir = tempProject({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    'node_modules/.keep': '',
  });
  const result = await envcheck.inspectProject(dir, { exec: NODE_OK, detect: require('../electron/detector').detectProject });
  const node = result.items.find((item) => item.id === 'node');
  assert.equal(node.status, 'ok');
  assert.match(node.detail, /node_modules/);
  assert.equal(result.summary.ok >= 1, true);
});

test('Node 项目：缺 node_modules 时黄灯，并在计划里给出安装命令', async () => {
  const dir = tempProject({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
  const result = await envcheck.inspectProject(dir, { exec: NODE_OK });
  const node = result.items.find((item) => item.id === 'node');
  assert.equal(node.status, 'missing');
  assert.match(node.detail, /node_modules/);

  const plan = envcheck.buildPlan(result);
  assert.equal(plan.steps.some((step) => step.command === 'npm install'), true);
  assert.equal(plan.consent.length, 0);
});

test('Node 项目：工具缺失时归入 consent，同意后才进入可执行步骤', async () => {
  const dir = tempProject({ 'package.json': '{}' });
  const result = await envcheck.inspectProject(dir, { exec: NODE_MISSING });
  const node = result.items.find((item) => item.id === 'node');
  assert.equal(node.status, 'missing');
  assert.match(node.detail, /Node\.js/);

  const plan = envcheck.buildPlan(result);
  assert.equal(plan.consent.length >= 1, true);
  assert.equal(plan.steps.length, 0);

  const withConsent = envcheck.buildPlan(result, { allowToolDownload: true });
  assert.equal(withConsent.steps.some((step) => step.needsConsent), true);
});

test('Python 项目：venv 缺依赖时黄灯并列出包名', async () => {
  const dir = tempProject({
    'requirements.txt': 'flask==3.0.0\nrequests>=2\n',
    '.venv/Scripts/python.exe': '',
  });
  const venvPython = path.join(dir, '.venv', 'Scripts', 'python.exe');
  const exec = fakeExec({
    python: 'Python 3.12.4',
    [`${venvPython} -m pip list --format=json`]: JSON.stringify([{ name: 'flask' }]),
  });
  const result = await envcheck.inspectProject(dir, { exec });
  const python = result.items.find((item) => item.id === 'python');
  assert.equal(python.status, 'missing');
  assert.match(python.detail, /requests/);
  assert.equal(python.install.length, 1);
  assert.match(python.install[0], /pip install -r requirements\.txt/);
});

test('Python 项目：依赖齐全时绿灯', async () => {
  const dir = tempProject({
    'requirements.txt': 'flask\nrequests\n',
    '.venv/Scripts/python.exe': '',
  });
  const venvPython = path.join(dir, '.venv', 'Scripts', 'python.exe');
  const exec = fakeExec({
    python: 'Python 3.12.4',
    [`${venvPython} -m pip list --format=json`]: JSON.stringify([{ name: 'Flask' }, { name: 'requests' }]),
  });
  const result = await envcheck.inspectProject(dir, { exec });
  const python = result.items.find((item) => item.id === 'python');
  assert.equal(python.status, 'ok');
  assert.match(python.detail, /依赖齐全/);
});

test('Python 项目：pip list 失败时红灯', async () => {
  const dir = tempProject({
    'requirements.txt': 'flask\n',
    '.venv/Scripts/python.exe': '',
  });
  const exec = fakeExec({ python: 'Python 3.12.4' });
  const result = await envcheck.inspectProject(dir, { exec });
  const python = result.items.find((item) => item.id === 'python');
  assert.equal(python.status, 'error');
  assert.match(python.detail, /依赖检查失败/);
});

test('uv 项目：本机没有 uv 时给出获取建议', async () => {
  const dir = tempProject({
    'pyproject.toml': '[project]\nname = "demo"\nrequires-python = ">=3.10"\n',
    'uv.lock': '',
  });
  const exec = fakeExec({ python: 'Python 3.12.4' });
  const result = await envcheck.inspectProject(dir, { exec });
  const python = result.items.find((item) => item.id === 'python');
  assert.equal(python.status, 'missing');
  assert.equal(python.consent.some((plan) => plan.tool === 'uv'), true);
  const plan = envcheck.buildPlan(result);
  assert.equal(plan.consent.some((step) => step.id === 'tool:uv'), true);
});

test('uv 项目：本机 uv 达标时优先用 uv sync', async () => {
  const dir = tempProject({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'uv.lock': '',
  });
  const exec = fakeExec({ python: 'Python 3.12.4', uv: 'uv 0.4.30' });
  const result = await envcheck.inspectProject(dir, { exec });
  const python = result.items.find((item) => item.id === 'python');
  assert.equal(python.status, 'missing');
  assert.deepEqual(python.install, ['uv sync']);
  assert.equal(python.consent.length, 0);
});

test('README 写明安装步骤但目录识别不出项目时，单独成条', async () => {
  const dir = tempProject({
    'README.md': '# demo\n\n```bash\npip install -r requirements.txt\n```\n',
    'requirements.txt': '',
  });
  const result = await envcheck.inspectProject(dir, { exec: fakeExec({ python: 'Python 3.12.4' }) });
  const readme = result.items.find((item) => item.id === 'readme');
  assert.ok(readme);
  assert.equal(readme.status, 'missing');
  assert.equal(readme.install[0], 'pip install -r requirements.txt');
  assert.equal(result.readme.file, 'README.md');
});

test('数据库：compose 里的 postgres 镜像被识别，且本机服务状态可见', async () => {
  const scOutput = [
    'SERVICE_NAME: postgresql-x64-16',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        STATE              : 1  STOPPED',
  ].join('\n');
  const dir = tempProject({
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5433:5432"\n',
  });
  const exec = fakeExec({ sc: scOutput, docker: 'Docker version 27.1.1, build 6312585' });
  const result = await envcheck.inspectProject(dir, { exec });
  assert.equal(result.database.engine, 'postgres');
  assert.equal(result.database.port, 5433);
  assert.equal(result.database.container, true);
  const item = result.items.find((entry) => entry.id === 'database');
  assert.equal(item.status, 'ok');
  assert.match(item.detail, /docker compose/);
});

test('removeEnvs 只删白名单内容且能报告删掉什么', () => {
  const dir = tempProject({
    'src/app.js': 'console.log(1)',
    '.venv/pyvenv.cfg': '',
    'node_modules/pkg/index.js': '',
    '.devdock/project.json': '{}',
    'devdock.cmd': 'start',
  });
  const residues = envcheck.listEnvResidue(dir);
  assert.equal(residues.some((item) => item.name === 'node_modules'), true);

  const removed = envcheck.removeEnvs(dir);
  assert.deepEqual(removed.sort(), ['.devdock', '.venv', 'devdock.cmd', 'node_modules'].sort());
  assert.equal(fs.existsSync(path.join(dir, 'src/app.js')), true);
  assert.equal(fs.existsSync(path.join(dir, '.venv')), false);
});

test('parseWindowsServices 解析 sc 输出', () => {
  const output = [
    'SERVICE_NAME: MySQL80',
    '        STATE              : 4  RUNNING',
    '',
    'SERVICE_NAME: postgresql-x64-16',
    '        STATE              : 1  STOPPED',
  ].join('\r\n');
  const services = dbstart.parseWindowsServices(output);
  assert.equal(services.length, 2);
  assert.equal(services[0].running, true);
  assert.equal(services[1].name, 'postgresql-x64-16');
});

test('buildDatabaseUrl 转义口令并拼出连接串', () => {
  const descriptor = { engine: 'postgres', port: 5432, user: 'postgres', database: 'app' };
  const url = dbstart.buildDatabaseUrl(descriptor, { password: 'p@ss word' });
  assert.equal(url, 'postgresql://postgres:p%40ss%20word@127.0.0.1:5432/app');

  const env = dbstart.buildEnvVars(descriptor, { password: 'secret' });
  assert.equal(env[0].key, 'DATABASE_URL');
  assert.equal(env[1].key, 'PGPASSWORD');
});

test('startLocalService 把拒绝访问翻译成管理员提示', async () => {
  const exec = async () => ({ ok: false, stdout: '', stderr: '发生系统错误 5。拒绝访问。', error: 'exit 2' });
  const result = await dbstart.startLocalService('postgresql-x64-16', { exec });
  assert.equal(result.ok, false);
  assert.match(result.message, /管理员/);
});
