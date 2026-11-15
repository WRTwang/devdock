'use strict';

const dotenv = require('./dotenv');

/**
 * 环境编排：保证同一时间只有一个活跃项目。
 * 依赖注入 store / runner，便于单元测试。
 */
class Environment {
  constructor({ store, runner, onEvent = () => {}, onLog = () => {} }) {
    this.store = store;
    this.runner = runner;
    this.onEvent = onEvent;
    this.onLog = onLog;
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

  async start(projectId) {
    const profile = this.require(projectId);
    if (!profile.startCommand.trim()) throw new Error('还没有配置启动命令');

    await this.activate(projectId, { reason: 'start' });

    if (profile.autoSetup && profile.setupCommand.trim() && !this.store.isSetup(projectId)) {
      this.#emit('phase', { projectId, phase: 'setup', message: '首次启动，先搭建环境…' });
      const code = await this.execAndWait(profile, profile.setupCommand, 'setup');
      if (code !== 0) throw new Error('环境搭建失败，请查看日志后重试');
      this.store.markSetup(projectId);
      this.#emit('setup-done', { projectId });
    }

    this.runner.exec(profile, { command: profile.startCommand, kind: 'start' });
    return { starting: true };
  }

  async setup(projectId) {
    const profile = this.require(projectId);
    if (!profile.setupCommand.trim()) throw new Error('还没有配置安装命令');

    await this.activate(projectId, { reason: 'setup' });

    this.execAndWait(profile, profile.setupCommand, 'setup')
      .then((code) => {
        if (code === 0) {
          this.store.markSetup(projectId);
          this.#emit('setup-done', { projectId });
        } else {
          this.#emit('error', { projectId, message: `搭建环境失败（退出码 ${code}）` });
        }
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
