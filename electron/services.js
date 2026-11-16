'use strict';

/**
 * 服务模型：一个项目可以包含前端 / 后端 / 数据库等多个服务。
 * 本模块只做数据归一化与旧档案迁移，不涉及排序、探测或编排。
 */

const ROLES = new Set(['frontend', 'backend', 'database', 'worker', 'app']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function toPort(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(number)) return null;
  if (number < 1 || number > 65535) return null;
  return number;
}

function normalizeEnvVars(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ key: text(item.key).trim(), value: text(item.value) }))
    .filter((item) => item.key.length > 0);
}

function normalizeDependsOn(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const id = text(item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 归一化单个服务。
 * @param {object} raw
 * @param {number} index 在列表中的下标，用于缺省 id
 */
function normalizeService(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = text(source.id).trim() || (index === 0 ? 'main' : `svc-${index + 1}`);
  const role = text(source.role).trim();

  return {
    id,
    name: text(source.name).trim() || id,
    role: ROLES.has(role) ? role : 'app',
    cwd: text(source.cwd).trim() || '.',
    setupCommand: text(source.setupCommand),
    startCommand: text(source.startCommand),
    port: toPort(source.port),
    envVars: normalizeEnvVars(source.envVars),
    dependsOn: normalizeDependsOn(source.dependsOn),
  };
}

/**
 * 解析项目包含的服务列表。
 * 旧档案（只有顶层 startCommand）会迁移成单个 app 服务。
 */
function resolveServices(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};

  if (Array.isArray(source.services) && source.services.length > 0) {
    return source.services.map((service, index) => normalizeService(service, index));
  }

  const startCommand = text(source.startCommand);
  const setupCommand = text(source.setupCommand);
  if (!startCommand && !setupCommand) return [];

  return [
    normalizeService(
      {
        id: 'main',
        name: text(source.name).trim() || 'main',
        role: 'app',
        cwd: '.',
        setupCommand,
        startCommand,
        envVars: source.envVars,
        dependsOn: [],
      },
      0,
    ),
  ];
}

/**
 * 按 dependsOn 做稳定拓扑排序（同一层保持输入顺序）。
 * 存在环时不返回部分顺序，而是把环上的服务 id 交回调用方。
 * @returns {{ order: object[], cycle: string[] | null }}
 */
function sortServices(services) {
  const list = Array.isArray(services) ? services : [];
  if (list.length === 0) return { order: [], cycle: null };

  const ids = new Set(list.map((service) => service.id));
  const position = new Map(list.map((service, index) => [service.id, index]));
  const indegree = new Map(list.map((service) => [service.id, 0]));
  const dependents = new Map(list.map((service) => [service.id, []]));

  for (const service of list) {
    const deps = new Set(Array.isArray(service.dependsOn) ? service.dependsOn : []);
    for (const dep of deps) {
      if (!ids.has(dep)) continue;
      dependents.get(dep).push(service.id);
      indegree.set(service.id, indegree.get(service.id) + 1);
    }
  }

  const ready = list.filter((service) => indegree.get(service.id) === 0).map((service) => service.id);
  const ordered = [];

  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a) - position.get(b));
    const id = ready.shift();
    ordered.push(id);
    for (const next of dependents.get(id)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (ordered.length !== list.length) {
    const cycle = list.filter((service) => indegree.get(service.id) > 0).map((service) => service.id);
    return { order: [], cycle };
  }

  return { order: ordered.map((id) => list[position.get(id)]), cycle: null };
}

module.exports = {
  ROLES,
  normalizeService,
  resolveServices,
  sortServices,
  normalizeEnvVars,
  normalizeDependsOn,
  toPort,
};
