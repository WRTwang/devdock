'use strict';

/**
 * 日志筛选与服务状态汇总（纯函数，UI 与测试共用）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DevDockLogFilter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeChunk(chunk) {
    if (!chunk || typeof chunk !== 'object') return null;
    return { ...chunk, serviceId: chunk.serviceId || 'main' };
  }

  function filterChunks(chunks, serviceId) {
    const list = Array.isArray(chunks) ? chunks : [];
    const normalized = list.map(normalizeChunk).filter(Boolean);
    if (!serviceId) return normalized;
    return normalized.filter((chunk) => chunk.serviceId === serviceId);
  }

  function summarizeServices(services, runningStatus) {
    const list = Array.isArray(services) ? services : [];
    const runningIds = new Set((runningStatus && runningStatus.services) || []);
    return list.map((service) => ({
      ...service,
      name: service.name || service.id,
      running: runningIds.has(service.id),
    }));
  }

  return { filterChunks, summarizeServices, normalizeChunk };
});
