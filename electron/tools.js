'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

/**
 * 本机工具探测：只读版本号，不安装任何东西。
 * 获取 / 升级工具的命令单独给出，是否执行由界面弹窗征得用户同意。
 */

const MINIMUMS = {
  node: '18.0.0',
  npm: '9.0.0',
  pnpm: '8.0.0',
  yarn: '1.22.0',
  bun: '1.0.0',
  python: '3.9.0',
  uv: '0.1.0',
  poetry: '1.2.0',
  docker: '20.10.0',
  cargo: '1.70.0',
  go: '1.20.0',
  dotnet: '6.0.0',
  ruby: '3.0.0',
  php: '8.0.0',
  java: '17.0.0',
};

const LABELS = {
  node: 'Node.js',
  npm: 'npm',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun',
  python: 'Python',
  uv: 'uv',
  poetry: 'Poetry',
  pipenv: 'pipenv',
  docker: 'Docker',
  cargo: 'Rust',
  go: 'Go',
  dotnet: '.NET',
  ruby: 'Ruby',
  php: 'PHP',
  java: 'Java',
};

const PROBES = {
  node: [['node', ['--version']]],
  npm: [['npm', ['--version']]],
  pnpm: [['pnpm', ['--version']]],
  yarn: [['yarn', ['--version']]],
  bun: [['bun', ['--version']]],
  python: [
    ['python', ['--version']],
    ['py', ['--version']],
    ['python3', ['--version']],
  ],
  uv: [['uv', ['--version']]],
  poetry: [['poetry', ['--version']]],
  pipenv: [['pipenv', ['--version']]],
  docker: [['docker', ['--version']]],
  cargo: [['cargo', ['--version']]],
  go: [['go', ['version']]],
  dotnet: [['dotnet', ['--version']]],
  ruby: [['ruby', ['--version']]],
  php: [['php', ['--version']]],
  java: [['java', ['-version']]],
};

/** 工具缺失或版本过低时可执行的获取命令。 */
const ACQUIRE = {
  node: {
    label: '安装 Node.js LTS',
    command: 'winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  npm: {
    label: '随 Node.js 一起安装 npm',
    command: 'winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  pnpm: {
    label: '安装 pnpm',
    command: 'npm install -g pnpm',
    download: true,
  },
  yarn: {
    label: '安装 yarn',
    command: 'npm install -g yarn',
    download: true,
  },
  bun: {
    label: '安装 bun',
    command: 'npm install -g bun',
    download: true,
  },
  python: {
    label: '安装 Python 3.13',
    command: 'winget install Python.Python.3.13 --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  uv: {
    label: '安装 uv（Python 环境管理器）',
    command: 'pip install -U uv',
    download: true,
  },
  poetry: {
    label: '安装 Poetry',
    command: 'pip install -U poetry',
    download: true,
  },
  pipenv: {
    label: '安装 pipenv',
    command: 'pip install -U pipenv',
    download: true,
  },
  docker: {
    label: '安装 Docker Desktop',
    command: 'winget install Docker.DockerDesktop --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  cargo: {
    label: '安装 Rust 工具链',
    command: 'winget install Rustlang.Rustup --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  go: {
    label: '安装 Go',
    command: 'winget install GoLang.Go --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  dotnet: {
    label: '安装 .NET SDK',
    command: 'winget install Microsoft.DotNet.SDK.8 --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  ruby: {
    label: '安装 Ruby',
    command: 'winget install RubyInstallerTeam.Ruby.3.3 --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  php: {
    label: '安装 PHP',
    command: 'winget install PHP.PHP --accept-source-agreements --accept-package-agreements',
    download: true,
  },
  java: {
    label: '安装 Microsoft OpenJDK',
    command: 'winget install Microsoft.OpenJDK.21 --accept-source-agreements --accept-package-agreements',
    download: true,
  },
};

function label(name) {
  return LABELS[name] || name;
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : parseVersion(a);
  const right = Array.isArray(b) ? b : parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function meetsMinimum(version, minimum) {
  if (!minimum) return true;
  if (!version) return false;
  return compareVersions(version, minimum) >= 0;
}

function formatVersion(version) {
  if (!version) return '';
  return Array.isArray(version) ? version.join('.') : String(version);
}

const WIN_SHIMS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pipenv', 'poetry']);

function quoteArg(value) {
  const text = String(value);
  return /\s|"/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function defaultExec(file, args, options = {}) {
  const settings = {
    windowsHide: true,
    timeout: options.timeoutMs || 8000,
    maxBuffer: 1024 * 1024,
    ...options,
  };

  const target =
    process.platform === 'win32' && WIN_SHIMS.has(path.basename(file).toLowerCase())
      ? {
          file: process.env.ComSpec || 'cmd.exe',
          args: ['/d', '/s', '/c', [file, ...args].map(quoteArg).join(' ')],
        }
      : { file, args };

  return new Promise((resolve) => {
    execFile(target.file, target.args, settings, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null,
      });
    });
  });
}

/**
 * 探测单个工具。会依次尝试候选可执行文件（例如 python / py / python3）。
 * @returns {Promise<{name:string,label:string,found:boolean,version:string|null,minimum:string|null,ok:boolean,command:string|null,error:string|null}>}
 */
async function probeTool(name, { exec = defaultExec, timeoutMs = 8000 } = {}) {
  const candidates = PROBES[name] || [[name, ['--version']]];
  const minimum = MINIMUMS[name] || null;
  let lastError = null;
  let lastCommand = null;

  for (const [file, args] of candidates) {
    lastCommand = [file, ...args].join(' ');
    const result = await exec(file, args, { timeoutMs });
    if (!result.ok) {
      lastError = result.error || result.stderr || `无法执行 ${file}`;
      continue;
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = parseVersion(output);
    if (!version) {
      lastError = `${file} 没有返回可识别的版本号`;
      continue;
    }
    return {
      name,
      label: label(name),
      found: true,
      version: formatVersion(version),
      minimum,
      ok: meetsMinimum(version, minimum),
      command: lastCommand,
      error: null,
    };
  }

  return {
    name,
    label: label(name),
    found: false,
    version: null,
    minimum,
    ok: false,
    command: lastCommand,
    error: lastError || '未找到该命令',
  };
}

/** 生成获取 / 升级工具的建议命令，需要用户确认。 */
function acquirePlan(name, version) {
  const spec = ACQUIRE[name];
  if (!spec) return null;
  const minimum = MINIMUMS[name] || null;
  const upgrading = Boolean(version);
  return {
    tool: name,
    title: upgrading ? `升级 ${label(name)}（当前 ${version}，建议 ≥ ${minimum || '最新'}）` : spec.label,
    command: spec.command,
    download: spec.download === true,
    needsConsent: true,
  };
}

/** 一次性探测一组工具，返回按名称索引的结果。 */
async function probeTools(names, options = {}) {
  const unique = [...new Set(names)].filter(Boolean);
  const results = await Promise.all(unique.map((name) => probeTool(name, options)));
  return new Map(results.map((item) => [item.name, item]));
}

module.exports = {
  MINIMUMS,
  ACQUIRE,
  PROBES,
  label,
  parseVersion,
  compareVersions,
  meetsMinimum,
  formatVersion,
  probeTool,
  probeTools,
  acquirePlan,
  defaultExec,
};
