'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildLauncherScript,
  buildProjectSnapshot,
  writeLauncher,
  readLauncher,
  readProjectArg,
  LAUNCHER_FILE,
  CONFIG_DIR,
} = require('../electron/linker');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-link-'));
}

const PROFILE = {
  id: 'p1',
  name: 'shop',
  dir: 'D:\\code\\shop',
  shell: 'cmd',
  envVars: [{ key: 'NODE_ENV', value: 'development' }],
  services: [
    { id: 'db', name: 'PostgreSQL', role: 'database', cwd: '.', startCommand: 'docker compose up -d db', port: 5432, dependsOn: [] },
    { id: 'api', name: 'API', role: 'backend', cwd: 'server', startCommand: 'npm run start:dev', port: 4000, dependsOn: ['db'] },
  ],
  autoSetup: true,
  syncDotEnv: false,
};

test('打包模式的启动脚本指向 exe 并传 --project', () => {
  const script = buildLauncherScript({
    exePath: 'C:\\Apps\\DevDock\\DevDock.exe',
    appPath: 'C:\\Apps\\DevDock\\resources\\app.asar',
    packaged: true,
  });
  assert.match(script, /C:\\Apps\\DevDock\\DevDock\.exe/);
  assert.match(script, /--project/);
  assert.match(script, /%~dp0/);
  assert.equal(script.includes('resources'), false);
});

test('开发模式同时传应用目录', () => {
  const script = buildLauncherScript({
    exePath: 'D:\\proj\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'D:\\proj',
    packaged: false,
  });
  assert.match(script, /electron\.exe/);
  assert.match(script, /--project/);
  assert.match(script, /D:\\proj/);
});

test('快照包含服务与环境变量', () => {
  const snapshot = buildProjectSnapshot(PROFILE);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.services.length, 2);
  assert.equal(snapshot.services[1].dependsOn[0], 'db');
  assert.deepEqual(snapshot.envVars, [{ key: 'NODE_ENV', value: 'development' }]);
});

test('写入 .devdock/project.json 和 devdock.cmd', () => {
  const dir = tmpProject();
  const result = writeLauncher(dir, { ...PROFILE, dir }, {
    exePath: 'C:\\Apps\\DevDock.exe',
    appPath: 'C:\\Apps',
    packaged: true,
  });

  assert.equal(result.launcherPath, path.join(dir, LAUNCHER_FILE));
  assert.equal(result.configPath, path.join(dir, CONFIG_DIR, 'project.json'));
  assert.ok(fs.existsSync(result.launcherPath));
  assert.ok(fs.existsSync(result.configPath));

  const snapshot = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
  assert.equal(snapshot.id, 'p1');
  assert.equal(snapshot.services.length, 2);
});

test('启动脚本使用 CRLF 换行，避免 cmd 解析异常', () => {
  const dir = tmpProject();
  const result = writeLauncher(dir, { ...PROFILE, dir }, {
    exePath: 'C:\\Apps\\DevDock.exe',
    appPath: 'C:\\Apps',
    packaged: true,
  });
  const raw = fs.readFileSync(result.launcherPath, 'utf8');
  assert.ok(raw.includes('\r\n'));
});

test('readLauncher 读回快照，不存在时返回 null', () => {
  const dir = tmpProject();
  assert.equal(readLauncher(dir), null);

  writeLauncher(dir, { ...PROFILE, dir }, {
    exePath: 'C:\\Apps\\DevDock.exe',
    appPath: 'C:\\Apps',
    packaged: true,
  });
  const snapshot = readLauncher(dir);
  assert.equal(snapshot.name, 'shop');
});

test('readLauncher 对损坏 JSON 返回 null', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIG_DIR, 'project.json'), '{ 坏数据', 'utf8');
  assert.equal(readLauncher(dir), null);
});

test('readProjectArg 支持空格与等号两种写法', () => {
  assert.equal(readProjectArg(['electron', '.', '--project', 'D:\\code\\shop']), 'D:\\code\\shop');
  assert.equal(readProjectArg(['DevDock.exe', '--project=D:\\code\\shop']), 'D:\\code\\shop');
  assert.equal(readProjectArg(['DevDock.exe']), null);
  assert.equal(readProjectArg(['--project']), null);
});
