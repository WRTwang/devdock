'use strict';

const path = require('node:path');
const dotenv = require('./dotenv');
const { resolveServices, sortServices } = require('./services');
const probe = require('./probe');

/**
 * 环境编排：保证同一时间只有一个活跃项目。
 * 依赖注入 store / runner，便于单元测试。
 */
class Environment {
  constructor({ store, runner, onEvent = () => {}, onLog = () => {}, waitForPort = probe.waitForPort }) {
    this.store = store;
    this.runner = runner;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.waitForPort = waitForPort;
  }

  get activeId() {
    return this.store.getState().activeId;
  }

  require(id) {
    const profile = this.store.find(id);
    if (!profile) throw new Error('项目不存在，可能已被删除');
    return profile;
  }

  #emit(type, payload = {}) {
    this.onEvent({ type, ...payload });
  }

  #restoreEnv(profile) {
    if (!profile || !profile.syncDotEnv) return;
    try {
      dotenv.restore(profile.dir);
    } catch (error) {
      this.#emit('error', { projectId: profile.id, message: `还原 .env 失败：${error.message}` });
    }
  }

  /**
   * 切换活跃环境。停掉上一个项目的全部进程，并还原它改过的 .env。
   */
  async activate(projectId, { reason = 'manual' } = {}) {
    const previousId = this.store.getState().activeId;
    if (previousId === projectId) {
      return { activeId: projectId, previousId, switched: false };
    }

    const next = this.require(projectId);

    if (previousId) {
      const previous = this.store.find(previousId);
      await this.runner.stop(previousId, { reason });
      this.#restoreEnv(previous);
      this.onLog({
        projectId,
        kind: 'meta',
        stream: 'meta',
        chunk: `[DevDock] 环境已切换：${previous ? previous.name : previousId} → ${next.name}\n`,
        ts: Date.now(),
        logFile: null,
      });
    }

    this.store.setActive(projectId);
    this.#emit('active', { activeId: projectId, previousId });
    return { activeId: projectId, previousId, switched: true };
  }

  execAndWait(profile, command, kind) {
    return new Promise((resolve, reject) => {
      let result;
      try {
        result = this.runner.exec(profile, { command, kind });
      } catch (error) {
        reject(error);
        return;
      }
      result.child.once('exit', (code) => resolve(code));
    });
  }

  /** 解析并按依赖顺序返回服务；旧档案自动迁移成单服务。 */
  servicesOf(profile) {
    const list =
      Array.isArray(profile.services) && profile.services.length > 0 ? profile.services : resolveServices(profile);
    const { order, cycle } = sortServices(list);
    if (cycle) throw new Error(`服务依赖存在环：${cycle.join(' → ')}`);
    return order;
  }

  /** 把服务配置展开成 runner 认识的执行上下文。 */
  derive(profile, service) {
    const cwd = service.cwd && service.cwd !== '.' ? path.resolve(profile.dir, service.cwd) : profile.dir;
    return {
      ...profile,
      dir: cwd,
      setupCommand: service.setupCommand || '',
      startCommand: service.startCommand || '',
      envVars: [...(profile.envVars || []), ...(service.envVars || [])],
      syncDotEnv: Boolean(profile.syncDotEnv) && cwd === profile.dir,
    };
  }

  async #setupServices(profile, services) {
    for (const service of services) {
      if (!service.setupCommand || !service.setupCommand.trim()) continue;
      this.#emit('phase', { projectId: profile.id, phase: 'setup', message: `正在安装 ${service.name} 依赖…` });
      const code = await this.execAndWait(this.derive(profile, service), service.setupCommand, 'setup');
      if (code !== 0) {
        throw new Error(`环境搭建失败：${service.name} 依赖安装失败（退出码 ${code}）`);
      }
    }
  }

  async #waitReady(profile, service) {
    if (!service.port) return;
    const timeoutMs = service.readyTimeoutMs || 60000;
    const result = await this.waitForPort(service.port, { timeoutMs });
    if (!result.ready) {
      const seconds = Math.max(1, Math.round(result.elapsedMs / 1000));
      throw new Error(`${service.name} 未就绪（端口 ${service.port} 在 ${seconds}s 内没有响应）`);
    }
    this.#emit('service-ready', { projectId: profile.id, serviceId: service.id, port: service.port });
  }

  async start(projectId) {
    const profile = this.require(projectId);
    const services = this.servicesOf(profile);

    if (services.length === 0) throw new Error('还没有配置启动命令');
    if (!services.some((service) => service.startCommand && service.startCommand.trim())) {
      throw new Error('还没有配置启动命令');
    }

    await this.activate(projectId, { reason: 'start' });

    if (profile.autoSetup && !this.store.isSetup(projectId)) {
      this.#emit('phase', { projectId, phase: 'setup', message: '首次启动，先搭建环境…' });
      await this.#setupServices(profile, services);
      this.store.markSetup(projectId);
      this.#emit('setup-done', { projectId });
    }

    const started = [];
    try {
      for (const service of services) {
        if (!service.startCommand || !service.startCommand.trim()) {
          await this.#waitReady(profile, service);
          continue;
        }

        this.runner.exec(this.derive(profile, service), { command: service.startCommand, kind: 'start' });
        started.push(service.id);

        if (service.role === 'database') {
          await this.#waitReady(profile, service);
        }
      }
    } catch (error) {
      if (started.length > 0) {
        try {
          await this.runner.stop(projectId, { reason: 'rollback' });
        } catch {
          /* 回滚尽力而为 */
        }
        this.#emit('rolled-back', { projectId, started });
      }
      throw error;
    }

    return { starting: true };
  }

  async setup(projectId) {
    const profile = this.require(projectId);
    const services = this.servicesOf(profile);
    const targets = services.filter((service) => service.setupCommand && service.setupCommand.trim());
    if (targets.length === 0) throw new Error('还没有配置安装命令');

    await this.activate(projectId, { reason: 'setup' });

    this.#setupServices(profile, targets)
      .then(() => {
        this.store.markSetup(projectId);
        this.#emit('setup-done', { projectId });
      })
      .catch((error) => {
        this.#emit('error', { projectId, message: error.message });
      });

    return { started: true };
  }

  async stop(projectId, { reason = 'manual' } = {}) {
    const profile = this.store.find(projectId);
    const stopped = await this.runner.stop(projectId, { reason });
    this.#restoreEnv(profile);
    this.#emit('stopped', { projectId });
    return { stopped };
  }

  async remove(projectId) {
    const profile = this.store.find(projectId);
    if (profile) {
      await this.runner.stop(projectId, { reason: 'delete' });
      this.#restoreEnv(profile);
    }
    this.store.remove(projectId);
    this.#emit('changed', { activeId: this.store.getState().activeId });
    return { id: projectId };
  }

  /** 退出应用前的同步清理。 */
  shutdown() {
    this.runner.stopAllSync();
    for (const profile of this.store.list()) this.#restoreEnv(profile);
  }
}

module.exports = { Environment };
