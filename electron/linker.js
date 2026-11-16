'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = '.devdock';
const CONFIG_FILE = 'project.json';
const LAUNCHER_FILE = 'devdock.cmd';

function quote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * 生成项目的 .devdock/project.json 快照。
 * 只保留可移植字段，不写入本机绝对路径以外的运行态数据。
 */
function buildProjectSnapshot(profile, { now = Date.now } = {}) {
  return {
    version: 1,
    id: profile.id,
    name: profile.name,
    dir: profile.dir,
    shell: profile.shell,
    envVars: Array.isArray(profile.envVars) ? profile.envVars : [],
    services: Array.isArray(profile.services) ? profile.services : [],
    autoSetup: profile.autoSetup !== false,
    syncDotEnv: Boolean(profile.syncDotEnv),
    exportedAt: now(),
  };
}

/**
 * 生成双击入口脚本。脚本把项目目录通过 --project 传给 DevDock。
 */
function buildLauncherScript({ exePath, appPath, packaged }) {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    `set "DEVDOCK_EXE=${exePath}"`,
    'if not exist "%DEVDOCK_EXE%" (',
    '  echo [DevDock] 找不到启动器: %DEVDOCK_EXE%',
    '  echo 请重新安装 DevDock，或在 DevDock 里重新保存该项目。',
    '  pause',
    '  exit /b 1',
    ')',
  ];

  if (packaged) {
    lines.push('start "" "%DEVDOCK_EXE%" --project "%~dp0"');
  } else {
    lines.push(`start "" "%DEVDOCK_EXE%" ${quote(appPath)} --project "%~dp0"`);
  }

  lines.push('exit /b 0', '');
  return lines.join('\r\n');
}

/**
 * 把启动器写入项目目录。
 * @returns {{ launcherPath: string, configPath: string }}
 */
function writeLauncher(dir, profile, options) {
  const target = path.join(dir, CONFIG_DIR);
  fs.mkdirSync(target, { recursive: true });

  const configPath = path.join(target, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(buildProjectSnapshot(profile), null, 2), 'utf8');

  const launcherPath = path.join(dir, LAUNCHER_FILE);
  fs.writeFileSync(launcherPath, buildLauncherScript(options), 'utf8');

  return { launcherPath, configPath };
}

/**
 * 读取项目内启动器快照；不存在或损坏时返回 null。
 */
function readLauncher(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, CONFIG_DIR, CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 从命令行参数里取出 --project 的值。 */
function readProjectArg(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = String(list[i]);
    if (item === '--project') {
      const next = list[i + 1];
      return next ? String(next) : null;
    }
    if (item.startsWith('--project=')) {
      const value = item.slice('--project='.length);
      return value || null;
    }
  }
  return null;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  LAUNCHER_FILE,
  buildProjectSnapshot,
  buildLauncherScript,
  writeLauncher,
  readLauncher,
  readProjectArg,
};
