'use strict';

/**
 * 日志分级：很多程序（Django、Flask、npm）会把正常进度写到 stderr，
 * 不能因为流是 stderr 就整片标红。只在内容像报错时才标红，警告标黄，
 * 其余 stderr 按普通信息显示。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DevDockLogSeverity = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ERROR_RE =
    /(error|exception|traceback|fatal|panic|failed|failure|denied|refused|EADDRINUSE|ECONNREFUSED|ECONNRESET|ENOENT|EACCES|EPERM|ETIMEDOUT|cannot find|can't find|not recognized|No module named|ModuleNotFoundError|SyntaxError|TypeError|ValueError|KeyError|AttributeError|ImportError|IndentationError|OperationalError|segmentation fault|access violation|错误|失败|异常|拒绝访问|权限不足)/i;
  const WARN_RE = /(warning|deprecat|warn\b|警告|已弃用)/i;
  const TRACEBACK_START = /Traceback \(most recent call last\)|^\s*File "[^"]*", line \d+/i;
  const TRACEBACK_MEMBER =
    /^\s|^File "|^[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)\b|^[A-Za-z_][\w.]*\.(?:Error|Exception)\b/;

  /**
   * 创建带状态的分类器（记住是否处在 traceback 块里）。
   * @returns {(stream:string, line:string) => string} 返回 span 的 class
   */
  function createClassifier() {
    let inBlock = false;

    return function classify(stream, line) {
      if (stream === 'meta') return 'line-meta';
      if (stream === 'system') return 'line-system';

      const text = String(line == null ? '' : line);
      if (stream !== 'stderr') {
        inBlock = false;
        return '';
      }
      if (!text.trim()) {
        inBlock = false;
        return '';
      }

      if (inBlock) {
        if (TRACEBACK_MEMBER.test(text)) return 'line-stderr';
        inBlock = false;
      }

      if (TRACEBACK_START.test(text)) {
        inBlock = true;
        return 'line-stderr';
      }
      if (ERROR_RE.test(text)) return 'line-stderr';
      if (WARN_RE.test(text)) return 'line-warn';
      return '';
    };
  }

  function splitLines(text) {
    return String(text == null ? '' : text).split('\n');
  }

  return { createClassifier, splitLines };
});
