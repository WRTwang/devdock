'use strict';

/**
 * 冒烟 + 截图脚本（开发辅助，不打包）。
 * 启动应用 → 注入两个演示项目 → 启动其中一个 → 截取运行中的界面。
 *
 *   node scripts/screenshot.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareDemoProjects() {
  const base = path.join(os.tmpdir(), 'devdock-demo');
  const apiDir = path.join(base, 'hello-api');
  const webDir = path.join(base, 'web-console');

  fs.mkdirSync(apiDir, { recursive: true });
  fs.mkdirSync(webDir, { recursive: true });

  fs.writeFileSync(
    path.join(apiDir, 'package.json'),
    JSON.stringify(
      { name: 'hello-api', version: '1.0.0', scripts: { dev: 'node server.js' } },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(apiDir, 'server.js'),
    `const http = require('node:http');
const server = http.createServer((req, res) => res.end('ok'));
server.listen(0, () => {
  console.log('[hello-api] listening on http://127.0.0.1:' + server.address().port);
  console.log('[hello-api] environment: ' + (process.env.NODE_ENV || 'undefined'));
  let n = 0;
  setInterval(() => console.log('[hello-api] heartbeat #' + ++n + '  GET /health 200 3ms'), 900);
});
`,
  );

  fs.writeFileSync(
    path.join(webDir, 'package.json'),
    JSON.stringify(
      { name: 'web-console', version: '1.0.0', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } },
      null,
      2,
    ),
  );

  return { apiDir, webDir };
}

async function waitForEndpoint(url, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时`);
}

function createCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });

  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function main() {
  const { apiDir, webDir } = prepareDemoProjects();
  const electronBinary = require('electron');
  const appData = path.join(os.tmpdir(), 'devdock-screenshot-profile');
  fs.rmSync(appData, { recursive: true, force: true });

  const child = spawn(electronBinary, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVDOCK_DEVTOOLS: '0',
      DEVDOCK_HIDDEN: '1',
      DEVDOCK_DATA_DIR: appData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const logs = [];
  child.stdout.on('data', (buffer) => logs.push(buffer.toString()));
  child.stderr.on('data', (buffer) => logs.push(buffer.toString()));

  try {
    const targets = await waitForEndpoint(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
    if (!page) throw new Error('没有找到页面 target');

    const cdp = createCdpClient(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await sleep(1200);

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
      }
      return result.result.value;
    };

    const injected = await evaluate(`(async () => {
      const api = window.devdock;
      const list = await api.list();
      for (const profile of list.profiles) {
        await api.remove(profile.id);
      }
      const a = await api.save({
        name: 'hello-api',
        dir: ${JSON.stringify(apiDir)},
        shell: 'cmd',
        setupCommand: '',
        startCommand: 'npm run dev',
        envVars: [
          { key: 'NODE_ENV', value: 'development' },
          { key: 'PORT', value: '4317' }
        ],
        autoSetup: false,
        syncDotEnv: false
      });
      await api.save({
        name: 'web-console',
        dir: ${JSON.stringify(webDir)},
        shell: 'cmd',
        setupCommand: 'npm install',
        startCommand: 'npm run dev',
        envVars: [],
        autoSetup: true,
        syncDotEnv: true
      });
      return a.id;
    })()`);

    await sleep(400);
    await evaluate(`(async () => {
      const api = window.devdock;
      await api.start(${JSON.stringify(injected)});
    })()`);
    await sleep(3200);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const outFile = path.join(ROOT, 'assets', 'screenshot.png');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
    console.log(`已保存截图 ${outFile}`);

    const status = await evaluate('(async () => JSON.stringify(await window.devdock.status()))()');
    console.log('运行状态:', status);

    cdp.close();
  } finally {
    try {
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      child.kill();
    }
    if (logs.length) console.log('--- electron 输出 ---\n' + logs.join('').slice(-2000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
