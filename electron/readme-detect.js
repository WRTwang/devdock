'use strict';

const SETUP_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b/,
  /^(?:pip3?|pipx)\s+install\b/,
  /^uv\s+(?:sync|pip\s+install)\b/,
  /^poetry\s+install\b/,
  /^cargo\s+(?:build|fetch)\b/,
  /^go\s+mod\s+download\b/,
  /^bundle\s+install\b/,
  /^composer\s+install\b/,
  /^dotnet\s+restore\b/,
  /^pnpm\s+install\b/,
];

const START_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/,
  /^(?:uvicorn|gunicorn|hypercorn|flask)\s+/,
  /^python3?\s+-m\s+(?:uvicorn|flask|django|fastapi)\b/,
  /^python3?\s+manage\.py\s+runserver\b/,
  /^python3?\s+(?:app|main|server)\.py\b/,
  /^cargo\s+run\b/,
  /^go\s+run\b/,
  /^dotnet\s+run\b/,
  /^docker\s+compose\s+up\b/,
  /^docker-compose\s+up\b/,
  /^rails\s+(?:server|s)\b/,
  /^bundle\s+exec\s+rails\b/,
  /^php\s+artisan\s+serve\b/,
  /^(?:mvn|\.\/gradlew|gradlew\.bat)\s+(?:spring-boot:run|bootRun)\b/,
];

const PORT_PATTERNS = [
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i,
  /--port[= ](\d{2,5})/,
];

const SKIP_LANGUAGES = new Set(['diff', 'patch', 'text', 'plain', 'log']);

/** 去掉 PowerShell / bash 提示符前缀。 */
function stripPrompt(line) {
  return line
    .replace(/^(?:PS\s+[^>]*?>|>|\$|λ|➜)\s*/, '')
    .trim();
}

/**
 * 把「带路径的解释器 + 参数」归一化成通用命令，仅用于匹配。
 * 例如 .\venv\Scripts\python.exe manage.py runserver → python manage.py runserver
 */
function normalizeForMatch(command) {
  const match = /^(?:"([^"]+)"|(\S+))\s+([\s\S]*)$/.exec(command);
  if (!match) return command;

  const exe = match[1] || match[2] || '';
  const base = exe.split(/[\\/]/).pop().toLowerCase();
  if (!/^(python|python3|py)(\.exe)?$/.test(base)) return command;

  const args = (match[3] || '').trim();
  if (/^-m\s+pip\s+install\b/i.test(args)) {
    return args.replace(/^-m\s+pip\s+install\s*/i, 'pip install ');
  }
  if (/^-m\s+(uvicorn|flask|django|fastapi)\b/i.test(args)) return args;
  if (/^manage\.py\b/i.test(args)) return `python ${args}`;
  if (/^(app|main|server)\.py\b/i.test(args)) return `python ${args}`;
  return command;
}

function classify(command) {
  const normalized = normalizeForMatch(command);
  if (SETUP_PATTERNS.some((pattern) => pattern.test(normalized))) return 'setup';
  if (START_PATTERNS.some((pattern) => pattern.test(normalized))) return 'start';
  return null;
}

/**
 * 判断安装命令属于哪个生态，用于把 README 命令并回对应体检项，
 * 避免同一件事被拆成两条（例如 venv 里的 pip install 又单列一条「README 安装步骤」）。
 */
function setupEcosystem(command) {
  const normalized = normalizeForMatch(command);
  if (/^(?:pip3?|pipx)\s+install\b/.test(normalized)) return 'python';
  if (/^(?:python3?|py)\s+-m\s+(?:pip|venv)\b/i.test(normalized)) return 'python';
  if (/^(?:uv\s+(?:sync|pip\s+install)|poetry\s+install|pipenv\s+install)\b/.test(normalized)) return 'python';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b/.test(normalized)) return 'node';
  if (/^cargo\s+(?:build|fetch)\b/.test(normalized)) return 'rust';
  if (/^go\s+mod\s+download\b/.test(normalized)) return 'go';
  if (/^bundle\s+install\b/.test(normalized)) return 'ruby';
  if (/^composer\s+install\b/.test(normalized)) return 'php';
  if (/^dotnet\s+restore\b/.test(normalized)) return 'dotnet';
  return null;
}

function nearestSection(lines, endIndex) {
  for (let i = endIndex; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    return line.replace(/^#+\s*/, '').slice(0, 60);
  }
  return '';
}

function extractPort(text) {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number.parseInt(match[1], 10);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

/**
 * 从 README 提取安装 / 启动命令与端口。
 * 只做静态文本识别，不执行任何命令；识别结果需用户在界面确认。
 */
function extractReadmeCommands(markdown) {
  const result = { found: false, setupCommand: '', startCommand: '', port: null, evidence: [] };
  if (typeof markdown !== 'string' || markdown.trim() === '') return result;

  const lines = markdown.split(/\r?\n/);
  const fence = /^```([A-Za-z0-9_-]*)\s*$/;
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const open = fence.exec(lines[i].trim());
    if (!open) continue;
    const language = open[1].toLowerCase();
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end].trim())) end += 1;
    blocks.push({ language, start, end, section: nearestSection(lines, i - 1) });
    i = end;
  }

  for (const block of blocks) {
    if (SKIP_LANGUAGES.has(block.language)) continue;

    for (let i = block.start; i < block.end; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const command = stripPrompt(line);
      if (!command) continue;
      const kind = classify(command);
      if (!kind) continue;

      if (kind === 'setup' && !result.setupCommand) {
        result.setupCommand = command;
        result.evidence.push({ kind, command, section: block.section });
      }
      if (kind === 'start' && !result.startCommand) {
        result.startCommand = command;
        result.evidence.push({ kind, command, section: block.section });
      }
    }
  }

  result.found = result.evidence.length > 0;
  result.port = extractPort(markdown);
  return result;
}

module.exports = { extractReadmeCommands, classify, setupEcosystem };
