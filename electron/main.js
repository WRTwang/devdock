'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { detectProject } = require('./detector');
const { Runner } = require('./runner');
const { Environment } = require('./environment');
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

  handle('profiles:delete', (id) => environment.remove(id));

  handle('profiles:detect', (dir) => detectProject(dir));

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
      broadcast('state:event', { type: 'running', ...payload });
    },
  });
  environment = new Environment({
    store,
    runner,
    onEvent: (payload) => broadcast('state:event', payload),
    onLog: (payload) => broadcast('log:event', payload),
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
