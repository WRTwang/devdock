'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 启动失败诊断：把「退出码 + 最近日志 + 启动命令」翻译成用户能看懂的问题，
 * 能自动修的给出 fix 动作，需要权限的给出提权入口。
 */

const PERMISSION_RE = /(拒绝访问|access is denied|EACCES|EPERM|error 5\b|\(0x5\)|requires elevation|需要管理员)/i;
const PORT_RE = /(EADDRINUSE|address already in use|每个套接字地址|端口已被占用|port .* already in use)/i;
const NOT_FOUND_RE = /(不是内部或外部命令|is not recognized as an internal or external command|command not found|ENOENT)/i;
const MODULE_RE = /(Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError|No module named)/i;
const SCRIPT_RE = /(Missing script|missing script|npm ERR!.*script)/i;
const DB_RE = /(ECONNREFUSED|connection refused|无法连接.*(5432|3306|6379|27017))/i;

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function cleanLines(text) {
  return String(text || '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^\[DevDock\]/.test(line));
}

function excerptOf(tail, limit = 8) {
  const lines = cleanLines(tail);
  return lines.slice(-limit);
}

function portFromTail(tail) {
  const match = /:(\d{4,5})\b/.exec(String(tail || ''));
  if (!match) return null;
  const port = Number.parseInt(match[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * 项目本身就是 DevDock 时，从项目里再启动它没有意义：新实例会被单实例锁直接结束。
 * 返回 null 表示不是自启动。
 */
function detectSelfLaunch({ cwd, command, appPath } = {}) {
  const dir = cwd ? path.resolve(cwd) : '';
  const cmd = String(command || '').toLowerCase();
  const looksLikeElectron = /electron\s*\./.test(cmd) || /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev)\b/.test(cmd);
  if (!looksLikeElectron) return null;

  let isDevDock = false;
  if (appPath && dir && path.resolve(appPath) === dir) isDevDock = true;

  if (!isDevDock) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'devdock' && /electron[\\/]main\.js/.test(String(pkg.main || ''))) isDevDock = true;
    } catch {
      /* 没有 package.json 就不是 */
    }
  }

  if (!isDevDock) return null;
  return {
    id: 'self-launch',
    severity: 'warning',
    title: '不能从 DevDock 里启动 DevDock 自己',
    message: '这个项目目录就是 DevDock 本身。再启动会开第二个实例，被单实例锁立刻结束（日志里的 code=0 和 0x5 缓存报错都来自这里）。',
    suggestions: ['直接双击 DevDock 图标使用', '要调试界面，在项目目录里手动运行 npm start', '如果只是想看这个项目的环境，旁边的「环境体检」就够'],
    autoFix: null,
    excerpt: [],
  };
}

function baseResult(partial) {
  return {
    severity: 'error',
    autoFix: null,
    excerpt: [],
    suggestions: [],
    ...partial,
  };
}

/**
 * 启动进程退出后的诊断。
 * @param {{exitCode?:number, elapsedMs?:number, tail?:string, command?:string,
 *          port?:number|null, serviceName?:string, quickExitMs?:number}} input
 */
function diagnoseStartFailure(input = {}) {
  const tail = String(input.tail || '');
  const exitCode = input.exitCode === undefined || input.exitCode === null ? null : Number(input.exitCode);
  const elapsedMs = Number(input.elapsedMs || 0);
  const command = String(input.command || '');
  const serviceName = String(input.serviceName || '服务');
  const port = input.port || portFromTail(tail);
  const quickExitMs = Number(input.quickExitMs || 5000);
  const excerpt = excerptOf(tail);
  const lower = tail.toLowerCase();
  const text = `${tail}\n${command}`;

  if (PERMISSION_RE.test(text)) {
    return baseResult({
      id: 'permission',
      title: '进程没有权限（拒绝访问 0x5）',
      message: `${serviceName} 启动时被系统拒绝访问。常见原因是缓存目录、项目目录或数据库服务需要管理员权限。`,
      detail: '日志里的「拒绝访问 (0x5)」「Access is denied」「EACCES」都属于这一类。',
      autoFix: 'elevate',
      elevate: true,
      suggestions: ['点「以管理员身份重启 DevDock」再试一次', '确认项目目录没有被杀毒软件 / 只读属性锁住', '换一个可写的缓存目录（若程序支持）'],
      excerpt,
    });
  }

  if (PORT_RE.test(text)) {
    return baseResult({
      id: 'port-in-use',
      title: `端口${port ? ` ${port} ` : ''}已被占用`,
      message: `${serviceName} 想监听的端口上已经有别的进程，先结束占用者再启动即可。`,
      autoFix: port ? 'kill-port' : null,
      port: port || null,
      suggestions: port ? [`自动结束占用 ${port} 的进程后重试`, `或手动改一个端口`] : ['查一下是哪个进程占着端口'],
      excerpt,
    });
  }

  if (NOT_FOUND_RE.test(text)) {
    return baseResult({
      id: 'command-not-found',
      title: '找不到启动命令',
      message: `${serviceName} 要执行的命令在这台电脑上不存在：${command || '（空命令）'}`,
      suggestions: ['打开「环境体检」安装缺失的运行时', '确认命令写在系统 PATH 里', '在项目设置里改成完整路径或换 Shell'],
      excerpt,
    });
  }

  if (SCRIPT_RE.test(text)) {
    return baseResult({
      id: 'script-missing',
      title: 'package.json 里没有这个脚本',
      message: `${serviceName} 执行的脚本不存在，检查 package.json 的 scripts。`,
      suggestions: ['在「配置」里改成存在的脚本，例如 npm run dev', '或直接写 node server.js'],
      excerpt,
    });
  }

  if (MODULE_RE.test(text)) {
    return baseResult({
      id: 'module-missing',
      title: '依赖没有装全',
      message: `${serviceName} 启动时找不到模块，通常是没有执行安装命令。`,
      suggestions: ['打开「环境体检」→「安装缺失项」', '在「配置」里确认安装命令（npm install / pip install -r requirements.txt）'],
      excerpt,
    });
  }

  if (DB_RE.test(lower)) {
    return baseResult({
      id: 'database-unreachable',
      title: '连不上数据库',
      message: `${serviceName} 启动时连数据库被拒绝，数据库可能没起或口令不对。`,
      suggestions: ['打开「环境体检」，在数据库卡片里输入密码并启动', '确认端口与连接串一致'],
      excerpt,
    });
  }

  if (exitCode === 0 && elapsedMs > 0 && elapsedMs < quickExitMs) {
    return baseResult({
      id: 'quick-exit',
      severity: 'warning',
      title: '进程启动后立刻退出（code=0）',
      message: `${serviceName} 的命令执行完就结束了，没有常驻。可能启动的是单实例程序、一次性脚本，或者命令本身只是打印版本号。`,
      suggestions: ['确认启动命令是长期运行的（dev server / 服务进程）', '如果这个项目是 DevDock 自己，请直接双击应用而不是从这里启动'],
      excerpt,
    });
  }

  if (exitCode !== null && exitCode !== 0) {
    return baseResult({
      id: 'exit-nonzero',
      title: `启动失败（退出码 ${exitCode}）`,
      message: `${serviceName} 进程异常退出，下面是最近的日志。`,
      suggestions: ['按日志里的第一条错误处理', '不确定就打开「环境体检」重新检测'],
      excerpt,
    });
  }

  return baseResult({
    id: 'exited',
    severity: 'warning',
    title: '进程已退出',
    message: `${serviceName} 的进程结束了。`,
    suggestions: ['检查启动命令是否需要常驻', '查看完整日志确认原因'],
    excerpt,
  });
}

module.exports = {
  diagnoseStartFailure,
  detectSelfLaunch,
  excerptOf,
  portFromTail,
  cleanLines,
};
