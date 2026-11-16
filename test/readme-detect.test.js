'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractReadmeCommands } = require('../electron/readme-detect');

test('英文 README 提取安装、启动与端口', () => {
  const markdown = `# Shop

## Getting Started

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

Open http://localhost:5173 to view it.
`;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.found, true);
  assert.equal(result.setupCommand, 'pnpm install');
  assert.equal(result.startCommand, 'pnpm dev');
  assert.equal(result.port, 5173);
});

test('中文 README 的快速开始同样生效', () => {
  const markdown = `# 项目

## 快速开始

\`\`\`bash
npm install
npm run dev
\`\`\`
`;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, 'npm install');
  assert.equal(result.startCommand, 'npm run dev');
});

test('Python 启动命令与 --port 提取', () => {
  const markdown = `## Run

\`\`\`bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
\`\`\`
`;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, 'pip install -r requirements.txt');
  assert.equal(result.startCommand, 'uvicorn app.main:app --reload --port 8000');
  assert.equal(result.port, 8000);
});

test('只有安装命令时只返回安装', () => {
  const markdown = `\`\`\`
npm install
\`\`\``;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.found, true);
  assert.equal(result.setupCommand, 'npm install');
  assert.equal(result.startCommand, '');
});

test('忽略注释行与无关命令', () => {
  const markdown = `\`\`\`bash
# npm install
git clone https://example.com/repo.git
cd repo
npm ci
\`\`\``;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, 'npm ci');
  assert.equal(result.startCommand, '');
});

test('多个代码块时优先取含启动命令的块', () => {
  const markdown = `## Install

\`\`\`bash
npm install
\`\`\`

## Dev

\`\`\`bash
npm run dev
\`\`\``;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, 'npm install');
  assert.equal(result.startCommand, 'npm run dev');
});

test('没有代码块时返回未找到', () => {
  const result = extractReadmeCommands('# 只有标题\n\n没有可执行片段。');
  assert.equal(result.found, false);
  assert.equal(result.setupCommand, '');
  assert.equal(result.startCommand, '');
});

test('空输入安全返回', () => {
  assert.equal(extractReadmeCommands('').found, false);
  assert.equal(extractReadmeCommands(null).found, false);
});

test('记录识别证据（命令 + 所在小节）', () => {
  const markdown = `## 本地开发

\`\`\`bash
pnpm install
pnpm dev
\`\`\``;
  const result = extractReadmeCommands(markdown);
  assert.ok(result.evidence.length >= 2);
  const start = result.evidence.find((item) => item.kind === 'start');
  assert.equal(start.command, 'pnpm dev');
  assert.match(start.section, /本地开发/);
});

test('diff 代码块不会被当成命令', () => {
  const markdown = `\`\`\`diff
+ npm install
- yarn install
\`\`\``;
  const result = extractReadmeCommands(markdown);
  assert.equal(result.found, false);
});

test('识别带虚拟环境解释器的命令', () => {
  const fence = '```';
  const markdown = [
    fence + 'powershell',
    String.raw`.\venv\Scripts\python.exe -m pip install -r requirements.txt`,
    String.raw`.\venv\Scripts\python.exe manage.py runserver 0.0.0.0:8001`,
    fence,
  ].join('\n');

  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, String.raw`.\venv\Scripts\python.exe -m pip install -r requirements.txt`);
  assert.equal(result.startCommand, String.raw`.\venv\Scripts\python.exe manage.py runserver 0.0.0.0:8001`);
  assert.equal(result.port, 8001);
});

test('去掉 PowerShell 提示符前缀', () => {
  const fence = '```';
  const markdown = [fence + 'powershell', 'PS D:\\code\\app> npm run dev', fence].join('\n');
  const result = extractReadmeCommands(markdown);
  assert.equal(result.startCommand, 'npm run dev');
});

test('python -m pip install 归一化为安装命令', () => {
  const fence = '```';
  const markdown = [fence + 'bash', 'python -m pip install -r requirements.txt', fence].join('\n');
  const result = extractReadmeCommands(markdown);
  assert.equal(result.setupCommand, 'python -m pip install -r requirements.txt');
});

test('manage.py migrate 不会被当成启动命令', () => {
  const fence = '```';
  const markdown = [
    fence + 'bash',
    'python manage.py migrate',
    'python manage.py runserver 0.0.0.0:8001',
    fence,
  ].join('\n');
  const result = extractReadmeCommands(markdown);
  assert.equal(result.startCommand, 'python manage.py runserver 0.0.0.0:8001');
});
