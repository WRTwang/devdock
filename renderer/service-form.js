'use strict';

/**
 * 服务表单的数据层：负责「档案 ↔ 表单行」的转换与校验。
 * 不碰 DOM，便于单元测试；浏览器里通过 window.DevDockServiceForm 使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../electron/services'));
  } else {
    root.DevDockServiceForm = factory(root.DevDockServices);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (services) {
  function buildRows(profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    const list =
      Array.isArray(source.services) && source.services.length > 0
        ? source.services
        : services.resolveServices(source);

    return list.map((service) => ({
      id: service.id,
      name: service.name,
      role: service.role,
      cwd: service.cwd,
      setupCommand: service.setupCommand,
      startCommand: service.startCommand,
      port: service.port,
      dependsOn: [...(service.dependsOn || [])],
      envVars: [...(service.envVars || [])],
    }));
  }

  function isBlank(row) {
    if (!row) return true;
    const name = String(row.name || '').trim();
    const start = String(row.startCommand || '').trim();
    const setup = String(row.setupCommand || '').trim();
    return !name && !start && !setup;
  }

  function collectServices(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const normalized = list
      .filter((row) => !isBlank(row))
      .map((row, index) => services.normalizeService(row, index));

    const ids = new Set(normalized.map((service) => service.id));
    for (const service of normalized) {
      service.dependsOn = service.dependsOn.filter((dep) => ids.has(dep) && dep !== service.id);
    }
    return normalized;
  }

  function validateRows(rows) {
    const list = collectServices(rows);
    const errors = [];

    if (list.length === 0) {
      errors.push('至少需要一个服务');
      return errors;
    }

    for (const service of list) {
      if (!service.startCommand.trim() && !service.setupCommand.trim()) {
        errors.push(`服务「${service.name}」需要至少一条安装或启动命令`);
      }
    }

    const { cycle } = services.sortServices(list);
    if (cycle) errors.push(`服务依赖存在环：${cycle.join(' → ')}`);

    return errors;
  }

  return { buildRows, collectServices, validateRows };
});
