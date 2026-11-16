'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { Store } = require('./store');
const { detectProject, findComposeFile } = require('./detector');
const { Runner } = require('./runner');
const { Environment } = require('./environment');
const envcheck = require('./envcheck');
const dbstart = require('./dbstart');
const { diagnoseStartFailure, detectSelfLaunch } = require('./diagnose');
const { findPortOwners, killPids } = require('./issuefix');
const linker = require('./linker');

const isDev = !app.isPackaged;

// 允许通过环境变量隔离数据目录（自动化测试 / 截图用），避免污染真实档案
if (process.env.DEVDOCK_DATA_DIR) {
  app.setPath('userData', process.env.DEVDOCK_DATA_DIR);
}

let win = null;
let store = null;
let runner = null;
let environment = null;
let logRoot = '';
let pendingProjectDir = null;
// 数据库口令只放内存：进程退出即消失，不写 profiles.json
const dbSecrets = new Map();

/** 把体检到的数据库描述持久化到档案，供下次启动前自启本机服务。 */
function persistDatabase(profile, database) {
  const db = database
    ? {
        engine: database.engine,
        port: database.port,
        container: database.container,
        user: database.user,
        database: database.database,
        localName: database.local ? database.local.name : '',
      }
    : null;
  if (JSON.stringify(profile.db || null) === JSON.stringify(db)) return profile;
  return store.saveProfile({ ...profile, db });
}

/** 以管理员身份重启 DevDock（权限类问题的一键修复入口）。 */
function relaunchAsAdmin() {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argList = args.length ? ` -ArgumentList ${args.map(quote).join(',')}` : '';
  const script = `Start-Process -FilePath ${quote(exe)}${argList} -Verb RunAs`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => app.quit(), 500);
}

/** 删除项目前停掉它自己的 docker compose 容器（保留数据卷）。 */
function composeDown(dir) {
  const composeFile = findComposeFile(dir);
  if (!composeFile) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['compose', '-f', composeFile, 'down', '--remove-orphans'],
      { cwd: dir, windowsHide: true, timeout: 120000 },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        resolve({
          ok: !error,
          message: error
            ? output.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || error.message
            : output.split(/\r?\n/).filter(Boolean).slice(-3).join(' '),
        });
      },
    );
  });
}

/** 启动项目前确保本机数据库服务已运行（容器数据库交给 docker compose）。 */
async function ensureDatabase(profile) {
  const secret = dbSecrets.get(profile.id);
  if (!profile.db || !secret) return null;
  if (profile.db.container) return null;
  if (!profile.db.localName) return null;

  const services = await dbstart.findLocalServices();
  const local = services.find((service) => service.name === profile.db.localName);
  if (local && local.running) return { message: `${local.name} 已在运行` };
  return dbstart.startLocalService(profile.db.localName);
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 从项目目录的 .devdock/project.json 导入档案，并通知界面自动启动。 */
function handleLaunchRequest(dir) {
  try {
    const absolute = path.resolve(dir);
    const snapshot = linker.readLauncher(absolute);
    if (!snapshot) throw new Error(`没有找到 ${linker.CONFIG_DIR}/${linker.CONFIG_FILE}：${absolute}`);

    const existing = store.list().find((profile) => path.resolve(profile.dir) === absolute);
    const input = linker.snapshotToProfile(snapshot, absolute, existing ? existing.id : null);
    if (!input) throw new Error('启动器配置不完整，请在 DevDock 里重新保存该项目');

    const profile = store.saveProfile(input);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    broadcast('state:event', { type: 'open-project', projectId: profile.id, autoStart: true });
  } catch (error) {
    broadcast('state:event', { type: 'error', message: error.message });
  }
}

function publicState() {
  const state = store.getState();
  return {
    profiles: state.profiles,
    activeId: state.activeId,
    setupAt: state.setupAt,
    running: runner.snapshot(),
    appVersion: app.getVersion(),
    dataDir: app.getPath('userData'),
    logRoot,
    platform: process.platform,
    dbReady: [...dbSecrets.keys()],
  };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  });
}

function registerIpc() {
  handle('profiles:list', () => publicState());

  handle('profiles:save', (input) => {
    if (!input || typeof input !== 'object') throw new Error('参数不合法');
    const dir = String(input.dir || '').trim();
    if (!dir) throw new Error('请填写项目路径');
    if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
    if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录: ${dir}`);

    const saved = store.saveProfile({ ...input, dir: path.resolve(dir) });
    if (!saved.linkLauncher) return saved;

    try {
      const launcher = linker.writeLauncher(saved.dir, saved, {
        exePath: process.execPath,
        appPath: app.getAppPath(),
        packaged: app.isPackaged,
      });
      return { ...saved, launcher };
    } catch (error) {
      return { ...saved, launcherError: error.message };
    }
  });

  handle('project:link', (id) => {
    const profile = store.find(id);
    if (!profile) throw new Error('项目不存在');
    if (!profile.linkLauncher) throw new Error('该项目已关闭启动器生成');
    return linker.writeLauncher(profile.dir, profile, {
      exePath: process.execPath,
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
    });
  });

  handle('profiles:delete', async (id, options) => {
    const opts = options && typeof options === 'object' ? options : {};
    const profile = store.find(id);
    let docker = null;
    if (profile && opts.removeEnv && opts.compose !== false) {
      try {
        docker = await composeDown(profile.dir);
      } catch (error) {
        docker = { ok: false, message: error.message };
      }
    }
    const result = await environment.remove(id, opts);
    dbSecrets.delete(id);
    return { ...result, docker };
  });

  handle('profiles:detect', (dir) => detectProject(dir));

  handle('env:inspect', async (id) => {
    const profile = store.find(id);
    if (!profile) throw new Error('项目不存在，可能已被删除');
    const inspection = await envcheck.inspectProject(profile.dir);
    const saved = persistDatabase(profile, inspection.database);
    return {
      ...inspection,
      plan: envcheck.buildPlan(inspection),
      dbReady: dbSecrets.has(saved.id),
    };
  });

  handle('env:install', (id, options) => environment.installPlan(id, options || {}));

  handle('issue:fix', async (id, payload) => {
    const profile = store.find(id);
    if (!profile) throw new Error('项目不存在，可能已被删除');
    const action = payload && payload.action;

    if (action === 'kill-port') {
      const port = Number.parseInt(String(payload.port ?? ''), 10);
      if (!port) throw new Error('没有拿到端口号');
      const owners = await findPortOwners(port);
      if (!owners.ok) throw new Error(owners.error);
      if (owners.pids.length === 0) {
        return { fixed: false, retry: false, message: `没有找到占用 ${port} 的进程，可能已经自行释放` };
      }
      const results = await killPids(owners.pids);
      const killed = results.filter((item) => item.ok).map((item) => item.pid);
      if (killed.length === 0) {
        const detail = results.map((item) => `${item.pid}: ${item.message || '失败'}`).join('；');
        throw new Error(`结束占用 ${port} 的进程失败：${detail}`);
      }
      return { fixed: true, retry: true, message: `已结束占用 ${port} 的进程：${killed.join(', ')}` };
    }

    if (action === 'elevate') {
      relaunchAsAdmin();
      return { fixed: true, retry: false, message: '正在以管理员身份重启 DevDock…' };
    }

    throw new Error('不支持的操作');
  });

  handle('env:residue', (dir) => {
    const target = path.resolve(String(dir || ''));
    if (!dir || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { items: [], compose: null };
    }
    return { items: envcheck.listEnvResidue(target), compose: findComposeFile(target) };
  });

  handle('db:prepare', async (id, input) => {
    const profile = store.find(id);
    if (!profile) throw new Error('项目不存在，可能已被删除');
    const options = input && typeof input === 'object' ? input : {};
    const inspection = await envcheck.inspectProject(profile.dir);
    const database = inspection.database;
    if (!database) throw new Error('没有检测到数据库环境');

    const secret = {
      password: String(options.password ?? ''),
      user: String(options.user || '').trim() || database.user,
      database: String(options.database || '').trim() || database.database,
    };
    const envVars = dbstart.buildEnvVars(database, secret);
    dbSecrets.set(profile.id, { envVars, engine: database.engine });

    store.saveProfile({
      ...profile,
      db: {
        engine: database.engine,
        port: database.port,
        container: database.container,
        user: secret.user,
        database: secret.database,
        localName: database.local ? database.local.name : '',
      },
      syncDotEnv: options.syncDotEnv === false ? profile.syncDotEnv : true,
    });

    let started = null;
    if (!database.container && database.local && !database.local.running) {
      started = await dbstart.startLocalService(database.local.name);
    }

    const url = dbstart.buildDatabaseUrl(database, secret).replace(/:([^:@/]*)@/, ':***@');
    broadcast('state:event', { type: 'db-ready', projectId: profile.id, engine: database.engine });
    return { engine: database.engine, label: database.label, url, started, container: database.container };
  });

  handle('dialog:pickDir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle('env:activate', (id) => environment.activate(id));

  handle('env:setup', (id) => environment.setup(id));

  handle('env:start', (id) => {
    environment.start(id).catch((error) => {
      if (error && error.code === 'self-launch') return;
      broadcast('state:event', { type: 'error', projectId: id, message: error.message });
    });
    return { starting: true };
  });

  handle('env:stop', (id) => environment.stop(id));

  handle('env:status', () => runner.snapshot());

  handle('shell:openDir', async (dir) => {
    if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在');
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return { opened: true };
  });

  handle('log:openDir', async () => {
    fs.mkdirSync(logRoot, { recursive: true });
    const error = await shell.openPath(logRoot);
    if (error) throw new Error(error);
    return { opened: true };
  });

  handle('log:reveal', async (file) => {
    if (!file || !fs.existsSync(file)) throw new Error('日志文件不存在');
    shell.showItemInFolder(file);
    return { revealed: true };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'DevDock',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0d10',
      symbolColor: '#9aa4b8',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.once('did-finish-load', () => {
    if (!pendingProjectDir) return;
    const dir = pendingProjectDir;
    pendingProjectDir = null;
    handleLaunchRequest(dir);
  });

  win.once('ready-to-show', () => {
    if (process.env.DEVDOCK_HIDDEN !== '1') win.show();
    if (isDev && process.env.DEVDOCK_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function bootstrap() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  logRoot = path.join(dataDir, 'logs');
  fs.mkdirSync(logRoot, { recursive: true });

  store = new Store(dataDir);
  runner = new Runner({
    logRoot,
    onLog: (payload) => broadcast('log:event', payload),
    onState: (payload) => {
      if (payload.kind === 'setup' && payload.running === false && payload.exitCode === 0) {
        store.markSetup(payload.projectId);
      }

      const { tail, ...visible } = payload;
      broadcast('state:event', { type: 'running', ...visible });

      if (payload.kind === 'start' && payload.running === false && !payload.stopped) {
        const profile = store.find(payload.projectId);
        const service =
          profile && Array.isArray(profile.services)
            ? profile.services.find((item) => item.id === payload.serviceId)
            : null;
        const diagnosis = diagnoseStartFailure({
          exitCode: payload.exitCode,
          elapsedMs: payload.elapsedMs,
          tail,
          command: payload.command,
          port: service ? service.port : null,
          serviceName: service ? service.name : payload.serviceId,
        });
        broadcast('state:event', {
          type: 'start-failed',
          projectId: payload.projectId,
          serviceId: payload.serviceId,
          diagnosis,
        });
      }
    },
  });
  environment = new Environment({
    store,
    runner,
    onEvent: (payload) => broadcast('state:event', payload),
    onLog: (payload) => broadcast('log:event', payload),
    secretVars: (profile) => {
      const secret = dbSecrets.get(profile.id);
      return secret ? secret.envVars : [];
    },
    ensureDatabase,
    checkSelfLaunch: (profile, service) =>
      detectSelfLaunch({
        cwd: service.cwd && service.cwd !== '.' ? path.resolve(profile.dir, service.cwd) : profile.dir,
        command: service.startCommand,
        appPath: app.getAppPath(),
      }),
  });

  registerIpc();
  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const dir = linker.readProjectArg(argv);
    if (dir) handleLaunchRequest(dir);
  });

  app.whenReady().then(() => {
    pendingProjectDir = linker.readProjectArg(process.argv);
    app.setAppUserModelId('io.github.devdock.app');
    bootstrap();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (environment) environment.shutdown();
});

process.on('uncaughtException', (error) => {
  console.error('[DevDock] 未捕获异常:', error);
});
