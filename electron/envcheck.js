'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectProject, findReadme, findComposeFile } = require('./detector');
const { extractReadmeCommands } = require('./readme-detect');
const tools = require('./tools');
const dbstart = require('./dbstart');

/**
 * 环境体检：把 README 说明和项目清单（package.json / requirements.txt / pyproject.toml …）
 * 合成一张「已有 / 缺失 / 异常」清单。只读探测，安装动作交回调用方并需要用户确认。
 */

const PY_VENV_DIRS = ['.venv', 'venv', 'env'];
const ENV_CANDIDATES = [...PY_VENV_DIRS, 'node_modules'];
const RESIDUE_CANDIDATES = ['.devdock', 'devdock.cmd', '.env.devdock.bak', '.pytest_cache', '__pycache__', '.mypy_cache'];

function readText(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
}

function readJson(dir, name) {
  try {
    return JSON.parse(readText(dir, name));
  } catch {
    return null;
  }
}

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function findVenv(dir) {
  for (const name of PY_VENV_DIRS) {
    const win = path.join(dir, name, 'Scripts', 'python.exe');
    const posix = path.join(dir, name, 'bin', 'python');
    if (fs.existsSync(win)) return { name, python: win };
    if (fs.existsSync(posix)) return { name, python: posix };
  }
  return null;
}

function findCaseFile(dir, name) {
  try {
    return fs.readdirSync(dir).find((entry) => entry.toLowerCase() === name.toLowerCase()) || null;
  } catch {
    return null;
  }
}

function normalizePackageName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '_');
}

/** 从 requirements.txt 提取顶层包名（忽略注释、-r、-e 与 URL 行）。 */
function parseRequirements(text) {
  const names = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    if (/^[a-z+]+:\/\//i.test(line) || line.startsWith('git+')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(line);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)];
}

/** 从 pyproject.toml 粗略提取依赖名，覆盖 PEP 621 与 Poetry 两种写法。 */
function parsePyprojectDependencies(text) {
  const source = String(text || '');
  const names = [];

  const projectBlock = /\[project\][\s\S]*?(?=\n\[|$)/.exec(source);
  if (projectBlock) {
    const deps = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(projectBlock[0]);
    if (deps) {
      for (const item of deps[1].split(',')) {
        const match = /["']([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(item.trim());
        if (match) names.push(match[1]);
      }
    }
  }

  const poetryBlock = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(source);
  if (poetryBlock) {
    for (const line of poetryBlock[1].split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/.exec(line);
      if (match && match[1].toLowerCase() !== 'python') names.push(match[1]);
    }
  }

  return [...new Set(names)];
}

function parseRequiresPython(text) {
  const match = /requires-python\s*=\s*["']([^"']+)["']/.exec(String(text || ''));
  if (!match) return null;
  const version = /(\d+)\.(\d+)/.exec(match[1]);
  if (!version) return null;
  return `${version[1]}.${version[2]}.0`;
}

function nodePackageManager(dir, pkg) {
  if (pkg && typeof pkg.packageManager === 'string') {
    const name = pkg.packageManager.split('@')[0].trim();
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
  }
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

function pythonBuilder(dir, probed, pyproject) {
  const uvLock = exists(dir, 'uv.lock');
  const poetryProject = /\[tool\.poetry\]/.test(pyproject);
  const pipfile = exists(dir, 'Pipfile');

  if (uvLock) {
    const uv = probed.get('uv');
    return {
      kind: 'uv',
      label: 'uv sync',
      commands: ['uv sync'],
      requires: ['uv'],
      consent: uv && uv.found && uv.ok ? [] : [tools.acquirePlan('uv', uv && uv.version)].filter(Boolean),
      note: uv && uv.found ? '' : '项目使用 uv 管理依赖，但本机没有可用的 uv',
    };
  }

  if (poetryProject) {
    const poetry = probed.get('poetry');
    return {
      kind: 'poetry',
      label: 'poetry install',
      commands: ['poetry install'],
      requires: ['poetry'],
      consent: poetry && poetry.found && poetry.ok ? [] : [tools.acquirePlan('poetry', poetry && poetry.version)].filter(Boolean),
      note: poetry && poetry.found ? '' : '项目使用 Poetry 管理依赖，但本机没有可用的 Poetry',
    };
  }

  if (pipfile) {
    const pipenv = probed.get('pipenv');
    return {
      kind: 'pipenv',
      label: 'pipenv install',
      commands: ['pipenv install'],
      requires: ['pipenv'],
      consent: pipenv && pipenv.found ? [] : [tools.acquirePlan('pipenv')].filter(Boolean),
      note: pipenv && pipenv.found ? '' : '项目使用 Pipfile，但本机没有 pipenv',
    };
  }

  return { kind: 'venv', label: 'python -m venv', commands: [], requires: ['python'], consent: [], note: '' };
}

function venvInstallCommand(dir, venvName, hasRequirements, hasPyproject) {
  const pythonRelative = path.join(venvName, 'Scripts', 'python.exe');
  const quote = (value) => `"${value}"`;
  const create = `python -m venv ${venvName}`;
  let install = '';
  if (hasRequirements) install = `${quote(pythonRelative)} -m pip install -r requirements.txt`;
  else if (hasPyproject) install = `${quote(pythonRelative)} -m pip install -e .`;
  else install = `${quote(pythonRelative)} -m pip install --upgrade pip`;
  return `${create} && ${install}`;
}

function missingPackages(python, required, exec) {
  return exec(python, ['-m', 'pip', 'list', '--format=json'], { timeoutMs: 20000 }).then((result) => {
    if (!result.ok) {
      return { ok: false, error: result.error || result.stderr || 'pip list 执行失败', missing: [] };
    }
    let installed;
    try {
      installed = JSON.parse(result.stdout || '[]');
    } catch {
      return { ok: false, error: 'pip list 输出无法解析', missing: [] };
    }
    const have = new Set(installed.map((item) => normalizePackageName(item.name || '')));
    const missing = required.filter((name) => !have.has(normalizePackageName(name)));
    return { ok: true, error: null, missing };
  });
}

function toolSummary(tool) {
  if (!tool) return '';
  if (!tool.found) return `${tool.label} 未安装`;
  return `${tool.label} ${tool.version}`;
}

function consentFor(tool, toolName) {
  if (!tool) return [];
  if (tool.found && tool.ok) return [];
  const plan = tools.acquirePlan(toolName || tool.name, tool.version);
  return plan ? [plan] : [];
}

async function inspectNode(dir, { detection, probed }) {
  if (!exists(dir, 'package.json')) return null;
  const pkg = readJson(dir, 'package.json') || {};
  const pm = nodePackageManager(dir, pkg);
  const node = probed.get('node');
  const manager = probed.get(pm);
  const nodeModules = exists(dir, 'node_modules');
  const setupCommand = detection.setupCommand || `${pm} install`;

  const toolsUsed = [node, manager].filter(Boolean);
  const consent = [...consentFor(node, 'node'), ...consentFor(manager, pm)];

  let status = 'ok';
  let detail = '';
  if (!node || !node.found) {
    status = 'missing';
    detail = '未找到 Node.js';
  } else if (!node.ok) {
    status = 'missing';
    detail = `Node.js 版本过低（当前 ${node.version}，需要 ≥ ${node.minimum}）`;
  } else if (!manager || !manager.found) {
    status = 'missing';
    detail = `未找到 ${pm}`;
  } else if (!manager.ok) {
    status = 'missing';
    detail = `${pm} 版本过低（当前 ${manager.version}，需要 ≥ ${manager.minimum}）`;
  } else if (!nodeModules) {
    status = 'missing';
    detail = '缺少 node_modules，依赖还没有安装';
  } else {
    detail = `${toolSummary(node)} · node_modules 已存在`;
  }

  return {
    id: 'node',
    label: 'Node.js 依赖',
    runtime: 'Node.js',
    status,
    detail,
    evidence: 'package.json',
    install: [setupCommand],
    consent,
    tools: toolsUsed.map((tool) => ({
      name: tool.name,
      label: tool.label,
      found: tool.found,
      version: tool.version,
      minimum: tool.minimum,
      ok: tool.ok,
    })),
  };
}

async function inspectPython(dir, { detection, probed, exec }) {
  const hasRequirements = exists(dir, 'requirements.txt');
  const hasPyproject = exists(dir, 'pyproject.toml');
  const hasPipfile = exists(dir, 'Pipfile');
  const hasManage = exists(dir, 'manage.py');
  if (!hasRequirements && !hasPyproject && !hasPipfile && !hasManage) return null;

  const pyproject = readText(dir, 'pyproject.toml');
  const python = probed.get('python');
  const builder = pythonBuilder(dir, probed, pyproject);
  const venv = findVenv(dir);
  const requiredVersion = parseRequiresPython(pyproject);

  const toolsUsed = [python, ...builder.requires.map((name) => probed.get(name)).filter(Boolean)].filter(Boolean);
  const consent = [...consentFor(python, 'python'), ...builder.consent].filter(Boolean);

  const required = [
    ...(hasRequirements ? parseRequirements(readText(dir, 'requirements.txt')) : []),
    ...(hasPyproject ? parsePyprojectDependencies(pyproject) : []),
    ...(hasPipfile ? parseRequirements(readText(dir, 'Pipfile')) : []),
  ];

  const install = builder.commands.length
    ? builder.commands
    : [venvInstallCommand(dir, (venv && venv.name) || '.venv', hasRequirements, hasPyproject)];

  let status = 'ok';
  let detail = '';

  if (!python || !python.found) {
    status = 'missing';
    detail = '未找到 Python 解释器';
  } else if (requiredVersion && tools.compareVersions(python.version, requiredVersion) < 0) {
    status = 'missing';
    detail = `Python 版本过低（当前 ${python.version}，项目要求 ≥ ${requiredVersion}）`;
  } else if (!venv) {
    status = 'missing';
    detail = `还没有创建虚拟环境（计划使用 ${builder.label}）`;
  } else if (builder.kind !== 'venv' && builder.consent.length > 0) {
    status = 'missing';
    detail = builder.note || `缺少 ${builder.requires.join(' / ')}`;
  } else {
    const pythonPath = venv.python;
    if (required.length > 0) {
      const check = await missingPackages(pythonPath, required, exec);
      if (!check.ok) {
        status = 'error';
        detail = `虚拟环境存在，但依赖检查失败：${check.error}`;
      } else if (check.missing.length > 0) {
        status = 'missing';
        const preview = check.missing.slice(0, 6).join('、');
        const rest = check.missing.length > 6 ? ` 等 ${check.missing.length} 个` : '';
        detail = `虚拟环境缺少依赖：${preview}${rest}`;
      } else {
        detail = `${venv.name} 已就绪 · ${required.length} 个依赖齐全`;
      }
    } else {
      detail = `${venv.name} 已就绪`;
    }
  }

  return {
    id: 'python',
    label: 'Python 依赖',
    runtime: 'Python',
    status,
    detail,
    evidence: hasRequirements ? 'requirements.txt' : hasPyproject ? 'pyproject.toml' : 'Pipfile',
    install,
    consent,
    tools: toolsUsed.map((tool) => ({
      name: tool.name,
      label: tool.label,
      found: tool.found,
      version: tool.version,
      minimum: tool.minimum,
      ok: tool.ok,
    })),
  };
}

async function inspectDocker(dir, { probed }) {
  if (!findComposeFile(dir)) return null;
  const docker = probed.get('docker');
  const consent = consentFor(docker, 'docker');

  let status = 'ok';
  let detail = '';
  if (!docker || !docker.found) {
    status = 'missing';
    detail = '项目包含 docker-compose，但未找到 Docker';
  } else if (!docker.ok) {
    status = 'missing';
    detail = `Docker 版本过低（当前 ${docker.version}，需要 ≥ ${docker.minimum}）`;
  } else {
    detail = `${toolSummary(docker)} · docker-compose 可用`;
  }

  return {
    id: 'docker',
    label: 'Docker 环境',
    runtime: 'Docker Compose',
    status,
    detail,
    evidence: findComposeFile(dir),
    install: [],
    consent,
    tools: docker
      ? [{ name: docker.name, label: docker.label, found: docker.found, version: docker.version, minimum: docker.minimum, ok: docker.ok }]
      : [],
  };
}

function databaseItem(database) {
  if (!database) return null;
  let status = 'ok';
  let detail = '';
  if (database.container) {
    detail = `${database.label} 由 docker compose 启动（端口 ${database.port}）`;
  } else if (database.local && database.local.running) {
    detail = `${database.label} 本机服务 ${database.local.name} 正在运行（端口 ${database.port}）`;
  } else if (database.local) {
    status = 'missing';
    detail = `本机已安装 ${database.label}（${database.local.name}），但服务没有启动`;
  } else {
    status = 'missing';
    detail = `没有检测到 ${database.label} 的本机服务，也没有可用的容器定义`;
  }

  return {
    id: 'database',
    label: `${database.label} 数据库`,
    runtime: database.label,
    status,
    detail,
    evidence: database.source === 'docker-compose' ? 'docker-compose' : '.env / README',
    install: [],
    consent: [],
    needsPassword: database.passwordRequired,
    tools: [],
  };
}

function listEnvResidue(dir) {
  const found = [];
  for (const name of [...ENV_CANDIDATES, ...RESIDUE_CANDIDATES]) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    found.push({
      name,
      path: target,
      kind: ENV_CANDIDATES.includes(name) ? 'env' : 'residue',
      directory: fs.statSync(target).isDirectory(),
    });
  }
  return found;
}

function assertInside(dir, target) {
  const base = path.resolve(dir) + path.sep;
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(dir) && !resolved.startsWith(base)) {
    throw new Error(`拒绝删除项目目录之外的路径: ${resolved}`);
  }
  return resolved;
}

/** 删除项目内的环境与 DevDock 残留，返回删掉的相对路径。 */
function removeEnvs(dir) {
  const removed = [];
  for (const item of listEnvResidue(dir)) {
    const target = assertInside(dir, item.path);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(item.name);
  }
  return removed;
}

/**
 * 体检一个项目目录。
 * @param {string} dir 项目绝对路径
 * @param {{exec?: Function, platform?: string, detect?: Function}} options 便于测试注入
 */
async function inspectProject(dir, options = {}) {
  const exec = options.exec || tools.defaultExec;
  const platform = options.platform || process.platform;
  const detect = options.detect || detectProject;

  const detection = detect(dir);
  const readmeName = findReadme(dir);
  const readmeText = readmeName ? readText(dir, readmeName) : '';
  const readme = readmeName ? extractReadmeCommands(readmeText) : { found: false, setupCommand: '', startCommand: '' };
  const composeFile = findComposeFile(dir);
  const composeText = composeFile ? readText(dir, composeFile) : '';
  const envText = ['.env', '.env.example', '.env.sample']
    .map((name) => readText(dir, findCaseFile(dir, name) || name))
    .join('\n');

  const toolNames = [];
  const pkg = exists(dir, 'package.json') ? readJson(dir, 'package.json') : null;
  if (pkg) toolNames.push('node', nodePackageManager(dir, pkg));
  if (exists(dir, 'requirements.txt') || exists(dir, 'pyproject.toml') || exists(dir, 'Pipfile') || exists(dir, 'manage.py')) {
    toolNames.push('python');
    if (exists(dir, 'uv.lock')) toolNames.push('uv');
    if (/\[tool\.poetry\]/.test(readText(dir, 'pyproject.toml'))) toolNames.push('poetry');
    if (exists(dir, 'Pipfile')) toolNames.push('pipenv');
  }
  if (composeFile) toolNames.push('docker');

  const probed = await tools.probeTools(toolNames, { exec });

  const database = await dbstart.detectDatabase({ composeText, readmeText, envText, services: detection.services, exec, platform });

  const items = [];
  const nodeItem = await inspectNode(dir, { detection, probed });
  if (nodeItem) items.push(nodeItem);
  const pythonItem = await inspectPython(dir, { detection, probed, exec });
  if (pythonItem) items.push(pythonItem);
  const dockerItem = await inspectDocker(dir, { probed });
  if (dockerItem) items.push(dockerItem);
  const dbItem = databaseItem(database);
  if (dbItem) items.push(dbItem);

  // README 里写了安装步骤但清单识别不出来时，单独列一条，避免“README 说了却没人执行”
  const readmeSetup = readme && readme.setupCommand ? readme.setupCommand : '';
  if (readmeSetup && !items.some((item) => item.install.includes(readmeSetup))) {
    items.push({
      id: 'readme',
      label: 'README 安装步骤',
      runtime: 'README',
      status: 'missing',
      detail: `来自 ${readmeName}：${readmeSetup}`,
      evidence: readmeName,
      install: [readmeSetup],
      consent: [],
      tools: [],
    });
  }

  const toolchain = [...probed.values()].map((tool) => ({
    name: tool.name,
    label: tool.label,
    found: tool.found,
    version: tool.version,
    minimum: tool.minimum,
    ok: tool.ok,
  }));

  const summary = {
    ok: items.filter((item) => item.status === 'ok').length,
    missing: items.filter((item) => item.status === 'missing').length,
    error: items.filter((item) => item.status === 'error').length,
  };

  return {
    dir,
    runtime: detection.runtime,
    readme: {
      file: readmeName,
      setupCommand: readmeSetup,
      startCommand: readme && readme.startCommand ? readme.startCommand : '',
      evidence: readme && readme.evidence ? readme.evidence : [],
    },
    items,
    database,
    residues: listEnvResidue(dir),
    toolchain,
    summary,
    checkedAt: Date.now(),
  };
}

/**
 * 生成安装计划。工具获取步骤需要用户同意（needsConsent），
 * allowToolDownload 为 false 时只返回本地能直接执行的步骤，其余放进 consent 供界面弹窗。
 */
function buildPlan(inspection, { allowToolDownload = false, itemIds = null } = {}) {
  const wanted = Array.isArray(itemIds) ? new Set(itemIds) : null;
  const steps = [];
  const consent = [];
  const seen = new Set();

  const push = (list, step) => {
    if (seen.has(step.command)) return;
    seen.add(step.command);
    list.push(step);
  };

  for (const item of inspection.items || []) {
    if (wanted && !wanted.has(item.id)) continue;
    if (item.status === 'ok') continue;

    const toolPlans = item.consent || [];
    for (const plan of toolPlans) {
      push(consent, {
        id: `tool:${plan.tool}`,
        itemId: item.id,
        title: plan.title,
        command: plan.command,
        needsConsent: true,
        download: plan.download,
      });
    }

    // 工具本身还没装好时，先不排安装命令：装依赖的命令本身也跑不起来
    if (toolPlans.length > 0) continue;

    for (const command of item.install || []) {
      push(steps, {
        id: `install:${item.id}`,
        itemId: item.id,
        title: `安装 ${item.label}`,
        command,
        needsConsent: false,
      });
    }
  }

  return {
    steps: allowToolDownload ? [...consent, ...steps] : steps,
    consent,
    hasWork: steps.length > 0 || consent.length > 0,
  };
}

module.exports = {
  ENV_CANDIDATES,
  RESIDUE_CANDIDATES,
  PY_VENV_DIRS,
  findVenv,
  parseRequirements,
  parsePyprojectDependencies,
  parseRequiresPython,
  normalizePackageName,
  inspectProject,
  buildPlan,
  listEnvResidue,
  removeEnvs,
};
