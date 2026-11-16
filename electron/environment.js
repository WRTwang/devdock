'use strict';

const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('./dotenv');
const { resolveServices, sortServices } = require('./services');
const probe = require('./probe');
const envcheck = require('./envcheck');
const { excerptOf } = require('./diagnose');

function tailHint(tail, limit = 5) {
  const lines = excerptOf(tail, limit);
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/**
 * 环境编排：保证同一时间只有一个活跃项目。
 * 依赖注入 store / runner，便于单元测试。
 */
class Environment {
  constructor({
    store,
    runner,
    onEvent = () => {},
    onLog = () => {},
    waitForPort = probe.waitForPort,
    secretVars = () => [],
    ensureDatabase = async () => null,
    inspectEnv = envcheck.inspectProject,
    checkSelfLaunch = () => null,
  }) {
    this.store = store;
    this.runner = runner;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.waitForPort = waitForPort;
    this.secretVars = secretVars;
    this.ensureDatabase = ensureDatabase;
    this.inspectEnv = inspectEnv;
    this.checkSelfLaunch = checkSelfLaunch;
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
      result.child.once('exit', (code) => {
        const serviceId = profile.serviceId || 'main';
        const tail = typeof this.runner.tail === 'function' ? this.runner.tail(profile.id, serviceId) : '';
        resolve({ code, tail });
      });
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
      serviceId: service.id,
      dir: cwd,
      setupCommand: service.setupCommand || '',
      startCommand: service.startCommand || '',
      envVars: [...(profile.envVars || []), ...(service.envVars || []), ...this.secretVars(profile)],
      syncDotEnv: Boolean(profile.syncDotEnv) && cwd === profile.dir,
    };
  }

  /**
   * 项目里有 venv 时，把 python / pip / uvicorn 这类命令切到 venv 解释器，
   * 否则用户启动的仍然是系统 Python（依赖装在 venv 里会找不到）。
   */
  commandFor(profile, service, command) {
    const text = String(command || '');
    if (!text.trim()) return command;
    if (/[\\/](?:Scripts|bin)[\\/]python(?:3)?(?:\.exe)?/i.test(text)) return command;

    const dir = service && service.cwd && service.cwd !== '.' ? path.resolve(profile.dir, service.cwd) : profile.dir;
    const venv = envcheck.findVenv(dir) || envcheck.findVenv(profile.dir);
    if (!venv) return command;

    const python = `"${venv.python}"`;
    const pip = /^pip3?\s+(.*)$/i.exec(text);
    if (pip) return `${python} -m pip ${pip[1]}`;
    if (/^(?:python|python3)(?:\.exe)?\s+/i.test(text)) {
      return text.replace(/^(?:python|python3)(?:\.exe)?\s+/i, `${python} `);
    }
    if (/^py(?:\.exe)?\s+/i.test(text)) return text.replace(/^py(?:\.exe)?\s+/i, `${python} `);

    const module = /^(uvicorn|gunicorn|hypercorn|flask|celery)\s+(.*)$/i.exec(text);
    if (module) return `${python} -m ${module[1]} ${module[2]}`;
    return command;
  }

  async #setupServices(profile, services) {
    for (const service of services) {
      if (!service.setupCommand || !service.setupCommand.trim()) continue;
      this.#emit('phase', { projectId: profile.id, phase: 'setup', message: `正在安装 ${service.name} 依赖…` });
      const outcome = await this.execAndWait(
        this.derive(profile, service),
        this.commandFor(profile, service, service.setupCommand),
        'setup',
      );
      if (outcome.code !== 0) {
        throw new Error(
          `环境搭建失败：${service.name} 依赖安装失败（退出码 ${outcome.code}）${tailHint(outcome.tail)}`,
        );
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

    for (const service of services) {
      const blocked = this.checkSelfLaunch(profile, service);
      if (blocked) {
        this.#emit('start-blocked', { projectId, serviceId: service.id, diagnosis: blocked });
        const error = new Error(`${blocked.title}：${blocked.message}`);
        error.code = blocked.id;
        throw error;
      }
    }

    if (profile.db) {
      try {
        const result = await this.ensureDatabase(profile);
        if (result && result.message) {
          this.#emit('phase', { projectId, phase: 'database', message: result.message });
        }
      } catch (error) {
        this.#emit('error', { projectId, message: `数据库启动失败：${error.message}` });
      }
    }

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

        this.runner.exec(this.derive(profile, service), {
          command: this.commandFor(profile, service, service.startCommand),
          kind: 'start',
        });
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

  /** 按体检计划逐个安装缺失环境项，日志走「环境」服务。 */
  async installPlan(projectId, { itemIds = null, allowToolDownload = false } = {}) {
    const profile = this.require(projectId);
    const inspection = await this.inspectEnv(profile.dir);
    const plan = envcheck.buildPlan(inspection, { itemIds, allowToolDownload });
    if (plan.steps.length === 0) {
      throw new Error(plan.consent.length > 0 ? '需要先同意下载或升级工具' : '体检通过，没有需要安装的环境项');
    }

    await this.activate(projectId, { reason: 'setup' });
    this.#emit('phase', { projectId, phase: 'setup', message: `开始安装 ${plan.steps.length} 个环境项…` });

    this.#runSteps(projectId, profile, plan.steps)
      .then(async () => {
        const after = await this.inspectEnv(profile.dir);
        const remaining = (after.items || []).filter(
          (item) => item.status !== 'ok' && item.id !== 'database' && item.id !== 'envfile' && item.id !== 'docker',
        );
        if (remaining.length > 0) {
          const labels = remaining.map((item) => `${item.label}（${item.detail || item.status}）`).join('；');
          this.#emit('setup-incomplete', {
            projectId,
            message: `安装结束，但还有 ${remaining.length} 项未就绪：${labels}`,
            items: remaining.map((item) => ({
              id: item.id,
              label: item.label,
              status: item.status,
              detail: item.detail,
            })),
          });
          return;
        }
        this.store.markSetup(projectId);
        this.#emit('setup-done', { projectId });
      })
      .catch((error) => {
        this.#emit('error', { projectId, message: error.message });
      });

    return { steps: plan.steps.map((step) => step.title), started: true };
  }

  async #runSteps(projectId, profile, steps) {
    for (const step of steps) {
      this.#emit('phase', { projectId, phase: 'setup', message: step.title });
      const context = this.derive(profile, {
        id: 'env',
        cwd: step.cwd || '.',
        setupCommand: '',
        startCommand: '',
        envVars: [],
      });

      if (step.action && step.action.kind === 'copy-env') {
        const from = path.resolve(context.dir, step.action.from);
        const to = path.resolve(context.dir, step.action.to);
        if (!fs.existsSync(from)) throw new Error(`${step.title} 失败：找不到 ${step.action.from}`);
        if (fs.existsSync(to)) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        this.onLog({
          projectId,
          serviceId: 'env',
          kind: 'setup',
          stream: 'meta',
          chunk: `[DevDock] 已复制 ${step.action.from} → ${step.action.to}\n`,
          ts: Date.now(),
          logFile: null,
        });
        continue;
      }

      if (!step.command) continue;
      const outcome = await this.execAndWait(context, step.command, 'setup');
      if (outcome.code !== 0) {
        throw new Error(`${step.title} 失败（退出码 ${outcome.code}）${tailHint(outcome.tail)}`);
      }
    }
  }

  /**
   * 删除项目档案。removeEnv 为 true 时顺带删除项目内的环境与 DevDock 残留；
   * includeBuild 控制是否连缓存 / 构建产物一起删。
   */
  async remove(projectId, { removeEnv = false, includeBuild = true } = {}) {
    const profile = this.store.find(projectId);
    let removedEnvs = [];
    if (profile) {
      await this.runner.stop(projectId, { reason: 'delete' });
      this.#restoreEnv(profile);
      if (removeEnv) {
        try {
          removedEnvs = envcheck.removeEnvs(profile.dir, { includeBuild });
        } catch (error) {
          this.#emit('error', { projectId, message: `删除环境失败：${error.message}` });
        }
      }
    }
    this.store.remove(projectId);
    this.#emit('changed', { activeId: this.store.getState().activeId });
    return { id: projectId, removedEnvs };
  }

  /** 退出应用前的同步清理。 */
  shutdown() {
    this.runner.stopAllSync();
    for (const profile of this.store.list()) this.#restoreEnv(profile);
  }
}

module.exports = { Environment };
