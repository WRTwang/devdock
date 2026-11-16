'use strict';

/**
 * 生成带模拟数据的界面预览（不需要启动 Electron）。
 * 用法：node scripts/preview.js  →  用浏览器打开 .preview/index.html
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.preview');

fs.mkdirSync(OUT, { recursive: true });

let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, '');
html = html.replace('../electron/services.js', 'services.core.js');
html = html.replace('<script src="app.js"></script>', '<script src="mock.js"></script>\n    <script src="app.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

fs.copyFileSync(path.join(ROOT, 'renderer', 'styles.css'), path.join(OUT, 'styles.css'));
fs.copyFileSync(path.join(ROOT, 'renderer', 'app.js'), path.join(OUT, 'app.js'));
fs.copyFileSync(path.join(ROOT, 'renderer', 'service-form.js'), path.join(OUT, 'service-form.js'));
fs.copyFileSync(path.join(ROOT, 'renderer', 'log-filter.js'), path.join(OUT, 'log-filter.js'));
fs.copyFileSync(path.join(ROOT, 'renderer', 'detect-summary.js'), path.join(OUT, 'detect-summary.js'));
fs.copyFileSync(path.join(ROOT, 'electron', 'services.js'), path.join(OUT, 'services.core.js'));

fs.writeFileSync(
  path.join(OUT, 'mock.js'),
  `'use strict';

const profiles = [
  {
    id: 'p-api',
    name: 'hello-api',
    dir: 'D:\\\\code\\\\hello-api',
    shell: 'powershell',
    setupCommand: 'pnpm install',
    startCommand: 'pnpm dev',
    stopCommand: '',
    envVars: [
      { key: 'NODE_ENV', value: 'development' },
      { key: 'DATABASE_URL', value: 'postgres://localhost:5432/app' },
    ],
    syncDotEnv: true,
    autoSetup: true,
    services: [
      { id: 'db', name: 'PostgreSQL', role: 'database', cwd: '.', setupCommand: '', startCommand: 'docker compose up -d db', port: 5432, envVars: [], dependsOn: [] },
      { id: 'api', name: 'API', role: 'backend', cwd: '.', setupCommand: 'pnpm install', startCommand: 'pnpm dev', port: 4317, envVars: [], dependsOn: ['db'] },
    ],
    createdAt: Date.now() - 86400000 * 12,
    lastUsedAt: Date.now() - 60000 * 3,
  },
  {
    id: 'p-web',
    name: 'web-console',
    dir: 'D:\\\\code\\\\web-console',
    shell: 'cmd',
    setupCommand: 'npm install',
    startCommand: 'npm run dev',
    stopCommand: '',
    envVars: [],
    syncDotEnv: false,
    autoSetup: true,
    services: [
      { id: 'web', name: 'Web', role: 'frontend', cwd: '.', setupCommand: 'npm install', startCommand: 'npm run dev', port: 5173, envVars: [], dependsOn: [] },
    ],
    createdAt: Date.now() - 86400000 * 30,
    lastUsedAt: Date.now() - 86400000,
  },
  {
    id: 'p-data',
    name: 'data-pipeline',
    dir: 'C:\\\\work\\\\data-pipeline',
    shell: 'cmd',
    setupCommand: 'uv sync',
    startCommand: 'uv run python -m pipeline serve',
    stopCommand: '',
    envVars: [{ key: 'PYTHONUNBUFFERED', value: '1' }],
    syncDotEnv: false,
    autoSetup: false,
    services: [
      { id: 'worker', name: 'Worker', role: 'worker', cwd: '.', setupCommand: 'uv sync', startCommand: 'uv run python -m pipeline serve', port: null, envVars: [], dependsOn: [] },
    ],
    createdAt: Date.now() - 86400000 * 60,
    lastUsedAt: null,
  },
];

const runtime = {
  'p-api': { runtime: 'Node.js', notes: ['识别到 NestJS 项目'] },
  'p-web': { runtime: 'Node.js', notes: ['识别到 Vite 项目'] },
  'p-data': { runtime: 'Python', notes: ['uv.lock 已存在，使用 uv 管理依赖'] },
};

let logCallback = null;
const scripts = [
  { stream: 'meta', text: '$ pnpm dev\\n' },
  { stream: 'stdout', text: '> hello-api@1.0.0 dev D:\\\\code\\\\hello-api\\n' },
  { stream: 'stdout', text: '> nest start --watch\\n\\n' },
  { stream: 'stdout', text: '[Nest] 21844  - 11/15/2026, 10:12:38 PM     LOG [NestFactory] Starting Nest application...\\n' },
  { stream: 'stdout', text: '[Nest] 21844  - 11/15/2026, 10:12:38 PM     LOG [InstanceLoader] AppModule dependencies initialized +18ms\\n' },
  { stream: 'stderr', text: '[Nest] 21844  - 11/15/2026, 10:12:39 PM   WARN [ConfigModule] DATABASE_URL points to localhost\\n' },
  { stream: 'stdout', text: '[Nest] 21844  - 11/15/2026, 10:12:39 PM     LOG [RoutesResolver] AppController {/}: +4ms\\n' },
  { stream: 'stdout', text: '[Nest] 21844  - 11/15/2026, 10:12:39 PM     LOG [NestApplication] Nest application successfully started +11ms\\n' },
  { stream: 'stdout', text: 'Server listening on http://127.0.0.1:4317\\n' },
];

setTimeout(() => {
  scripts.forEach((chunk, index) => {
    setTimeout(
      () => logCallback && logCallback({ projectId: 'p-api', serviceId: 'api', stream: chunk.stream, chunk: chunk.text }),
      index * 90,
    );
  });
}, 450);

let beat = 0;
setInterval(() => {
  beat += 1;
  if (logCallback) {
    logCallback({
      projectId: 'p-api',
      serviceId: 'api',
      stream: 'stdout',
      chunk: 'GET /v1/health 200 - ' + (2 + (beat % 5)) + 'ms\\n',
    });
    if (beat % 3 === 0) {
      logCallback({
        projectId: 'p-api',
        serviceId: 'db',
        stream: 'stdout',
        chunk: 'LOG:  checkpoint complete: wrote 3 buffers (0.0%)\\n',
      });
    }
  }
}, 2400);

window.devdock = {
  list: async () => ({
    profiles,
    activeId: 'p-api',
    setupAt: { 'p-api': Date.now() - 86400000 * 12 },
    running: { 'p-api': { running: true, kinds: ['start'], pids: [21844], startedAt: Date.now() - 60000 } },
    appVersion: '0.1.0',
    dataDir: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\DevDock',
    logRoot: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\DevDock\\\\logs',
    platform: 'win32',
  }),
  detect: async (dir) => {
    const key = Object.keys(runtime).find((id) => profiles.find((p) => p.id === id && p.dir === dir));
    return key ? runtime[key] : { runtime: null, setupCommand: '', startCommand: '', notes: ['未识别项目类型，请手动填写安装与启动命令'] };
  },
  save: async (profile) => ({ ...profile, id: profile.id || 'p-new' }),
  remove: async (id) => ({ id }),
  pickDir: async () => null,
  activate: async (id) => ({ activeId: id }),
  setup: async () => ({ started: true }),
  start: async () => ({ starting: true }),
  stop: async () => ({ stopped: 1 }),
  status: async () => ({}),
  openDir: async () => ({ opened: true }),
  openLogs: async () => ({ opened: true }),
  revealLog: async () => ({ revealed: true }),
  onLog: (callback) => {
    logCallback = callback;
    return () => {};
  },
  onState: () => () => {},
};
`,
);

console.log(`预览已生成：${path.join(OUT, 'index.html')}`);
