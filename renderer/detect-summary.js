'use strict';

/**
 * 把检测结果翻译成一句人话，告诉用户命令来自哪里，便于判断是否需要手改。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DevDockDetectSummary = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function describeDetection(result) {
    if (!result || typeof result !== 'object') return '未识别项目类型，请手动填写';

    const parts = [];
    const sources = result.sources || {};
    const readme = result.readme || null;
    const file = (readme && readme.file) || 'README.md';

    if (result.runtime) parts.push(`识别为 ${result.runtime}`);

    if (sources.setup === 'readme') parts.push(`安装命令来自 ${file}`);
    if (sources.start === 'readme') parts.push(`启动命令来自 ${file}`);

    if (readme && readme.port) parts.push(`端口 ${readme.port}`);

    if (Array.isArray(result.services) && result.services.length > 1 && readme) {
      parts.push(`${file} 的整体命令未套用到多服务`);
    }

    if (parts.length === 0) return '未识别项目类型，请手动填写';
    return parts.join(' · ');
  }

  return { describeDetection };
});
