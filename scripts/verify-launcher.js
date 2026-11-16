'use strict';

/**
 * 验证项目内启动器：直接以 `--project <dir>` 启动应用，确认它自动导入档案并拉起服务。
 * 用法：node scripts/verify-launcher.js "<项目目录>"
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9666;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint(url, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
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
    close: () => socket.close(),
  };
}

async function main() {
  const projectDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'devdock-demo', 'hello-api'));
  if (!fs.existsSync(path.join(projectDir, '.devdock', 'project.json'))) {
    throw new Error(`没有找到 ${projectDir}\\.devdock\\project.json，请先在 DevDock 里保存该项目`);
  }

  const appData = path.join(os.tmpdir(), 'devdock-launcher-check');
  fs.rmSync(appData, { recursive: true, force: true });

  const child = spawn(
    require('electron'),
    ['.', '--project', projectDir, `--remote-debugging-port=${PORT}`],
    {
      cwd: ROOT,
      env: { ...process.env, DEVDOCK_HIDDEN: '1', DEVDOCK_DATA_DIR: appData, DEVDOCK_DEVTOOLS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );

  const logs = [];
  child.stdout.on('data', (buffer) => logs.push(buffer.toString()));
  child.stderr.on('data', (buffer) => logs.push(buffer.toString()));

  try {
    const targets = await waitForEndpoint(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('没有找到页面 target');

    const cdp = createCdpClient(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '页面脚本失败');
      return result.result.value;
    };

    let status = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const raw = await evaluate('(async () => JSON.stringify(await window.devdock.status()))()');
      status = JSON.parse(raw);
      if (Object.keys(status).length > 0) break;
    }

    console.log('项目目录:', projectDir);
    console.log('自动导入的档案:', await evaluate(`(async () => { const s = await window.devdock.list(); return JSON.stringify(s.profiles.map(p => ({ name: p.name, services: p.services.map(x => x.id) }))); })()`));
    console.log('运行状态:', JSON.stringify(status));

    const running = Object.values(status).some((entry) => entry.running);
    if (!running) throw new Error('没有检测到自动启动的服务');
    console.log('结论: 启动器成功自动拉起项目服务');
    cdp.close();
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    if (logs.length) console.log('--- electron 输出（尾部）---\n' + logs.join('').slice(-800));
  }
}

main().catch((error) => {
  console.error('验证失败:', error.message);
  process.exitCode = 1;
});
