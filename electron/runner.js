'use strict';

const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('./dotenv');

function buildInvocation(shell, command) {
  if (shell === 'powershell') {
    const prelude =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ';
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command],
    };
  }
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`],
  };
}

function timestamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
  });
}

class Runner {
  constructor({ logRoot, onLog, onState }) {
    this.logRoot = logRoot;
    this.onLog = onLog || (() => {});
    this.onState = onState || (() => {});
    this.running = new Map(); // projectId -> Set<entry>
    fs.mkdirSync(logRoot, { recursive: true });
  }

  #entries(projectId, create = false) {
    let set = this.running.get(projectId);
    if (!set && create) {
      set = new Set();
      this.running.set(projectId, set);
    }
    return set || new Set();
  }

  isRunning(projectId) {
    return this.#entries(projectId).size > 0;
  }

  status(projectId) {
    const entries = [...this.#entries(projectId)];
    return {
      running: entries.length > 0,
      kinds: [...new Set(entries.map((entry) => entry.kind))],
      services: [...new Set(entries.map((entry) => entry.serviceId))],
      pids: entries.map((entry) => entry.pid).filter(Boolean),
      startedAt: entries.length ? Math.min(...entries.map((entry) => entry.startedAt)) : null,
    };
  }

  snapshot() {
    const result = {};
    for (const projectId of this.running.keys()) result[projectId] = this.status(projectId);
    return result;
  }

  #emit(projectId, serviceId, kind, stream, chunk, logFile) {
    this.onLog({ projectId, serviceId, kind, stream, chunk, ts: Date.now(), logFile });
  }

  /**
   * 在项目目录执行一条命令，实时广播输出。
   * @param {object} profile
   * @param {{ command: string, kind: 'setup'|'start'|'stop' }} options
   */
  exec(profile, { command, kind }) {
    if (!command || !command.trim()) {
      throw new Error(kind === 'setup' ? '还没有配置安装命令' : '还没有配置启动命令');
    }
    if (!fs.existsSync(profile.dir)) throw new Error(`项目目录不存在: ${profile.dir}`);

    const serviceId = profile.serviceId || 'main';
    if (kind === 'start' && [...this.#entries(profile.id)].some((entry) => entry.serviceId === serviceId)) {
      throw new Error(`服务已在运行中: ${serviceId}`);
    }

    const logDir = path.join(this.logRoot, profile.id, serviceId);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${timestamp()}-${kind}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    if (profile.syncDotEnv) {
      try {
        dotenv.apply(profile.dir, profile.envVars);
      } catch (error) {
        stream.end();
        throw new Error(`写入 .env 失败: ${error.message}`);
      }
    }

    const env = dotenv.toProcessEnv(process.env, profile.envVars);
    env.DEVDOCK = '1';
    env.DEVDOCK_PROJECT = profile.name;

    const { file, args } = buildInvocation(profile.shell, command);
    let child;
    try {
      child = spawn(file, args, {
        cwd: profile.dir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stream.end();
      if (profile.syncDotEnv) dotenv.restore(profile.dir);
      throw error;
    }

    const entry = {
      pid: child.pid,
      kind,
      serviceId,
      child,
      stream,
      stopping: false,
      startedAt: Date.now(),
      logFile,
      command,
      tail: '',
    };
    this.#entries(profile.id, true).add(entry);

    this.#emit(profile.id, serviceId, kind, 'meta', `$ ${command}\n`, logFile);

    const forward = (streamName) => (buffer) => {
      const text = buffer.toString('utf8');
      entry.tail = `${entry.tail}${text}`.slice(-12000);
      stream.write(text);
      this.#emit(profile.id, serviceId, kind, streamName, text, logFile);
    };
    child.stdout.on('data', forward('stdout'));
    child.stderr.on('data', forward('stderr'));

    child.on('error', (error) => {
      const text = `\n[DevDock] 启动失败: ${error.message}\n`;
      stream.write(text);
      this.#emit(profile.id, serviceId, kind, 'stderr', text, logFile);
    });

    child.on('exit', (code, signal) => {
      const set = this.#entries(profile.id);
      set.delete(entry);
      if (set.size === 0) this.running.delete(profile.id);

      const prefix = entry.stopping ? '[DevDock] 已停止' : `[DevDock] 进程退出`;
      const detail = signal ? `signal=${signal}` : `code=${code}`;
      const text = `\n${prefix} (${detail})\n`;
      stream.write(text);
      this.#emit(profile.id, serviceId, kind, 'meta', text, logFile);
      stream.end();

      if (profile.syncDotEnv && !this.isRunning(profile.id)) {
        try {
          dotenv.restore(profile.dir);
        } catch (error) {
          this.#emit(profile.id, serviceId, kind, 'stderr', `[DevDock] 还原 .env 失败: ${error.message}\n`, logFile);
        }
      }

      this.onState({
        projectId: profile.id,
        serviceId,
        kind,
        running: this.isRunning(profile.id),
        exitCode: code,
        stopped: entry.stopping,
        elapsedMs: Date.now() - entry.startedAt,
        command: entry.command,
        tail: entry.tail,
      });
    });

    this.onState({ projectId: profile.id, serviceId, kind, running: true, pid: child.pid });
    return { pid: child.pid, logFile, child };
  }

  async stop(projectId, { reason = 'manual' } = {}) {
    const entries = [...this.#entries(projectId)];
    await Promise.all(
      entries.map((entry) => {
        entry.stopping = true;
        entry.stopReason = reason;
        return killTree(entry.pid);
      }),
    );
    return entries.length;
  }

  async stopAll() {
    const tasks = [];
    for (const projectId of [...this.running.keys()]) tasks.push(this.stop(projectId, { reason: 'shutdown' }));
    return Promise.all(tasks);
  }

  stopAllSync() {
    for (const set of this.running.values()) {
      for (const entry of set) {
        entry.stopping = true;
        try {
          spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
        } catch {
          /* 尽力而为 */
        }
      }
    }
  }
}

module.exports = { Runner, buildInvocation };
