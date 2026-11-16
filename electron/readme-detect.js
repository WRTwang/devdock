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
  /^python3?\s+(?:manage\.py|app\.py|main\.py|server\.py)\b/,
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

const PORT_PATTERNS = [/localhost:(\d{2,5})/i, /127\.0\.0\.1:(\d{2,5})/, /--port[= ](\d{2,5})/];

const SKIP_LANGUAGES = new Set(['diff', 'patch', 'text', 'plain', 'log']);

function classify(command) {
  if (SETUP_PATTERNS.some((pattern) => pattern.test(command))) return 'setup';
  if (START_PATTERNS.some((pattern) => pattern.test(command))) return 'start';
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
      const command = line.replace(/^\$\s+/, '');
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

module.exports = { extractReadmeCommands, classify };
