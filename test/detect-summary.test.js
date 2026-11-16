'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeDetection } = require('../renderer/detect-summary');

test('目录结构识别只显示类型', () => {
  const text = describeDetection({
    runtime: 'Node.js',
    sources: { setup: 'structure', start: 'structure' },
    notes: [],
  });
  assert.equal(text, '识别为 Node.js');
});

test('README 覆盖启动命令时标注来源', () => {
  const text = describeDetection({
    runtime: 'Node.js',
    sources: { setup: 'structure', start: 'readme' },
    readme: { file: 'README.md', port: null },
  });
  assert.match(text, /启动命令来自 README\.md/);
});

test('安装与启动都来自 README 时都标注', () => {
  const text = describeDetection({
    runtime: 'Python',
    sources: { setup: 'readme', start: 'readme' },
    readme: { file: 'README.md', port: 8000 },
  });
  assert.match(text, /安装命令来自 README\.md/);
  assert.match(text, /启动命令来自 README\.md/);
  assert.match(text, /端口 8000/);
});

test('未识别类型时给出提示', () => {
  const text = describeDetection({ runtime: null, sources: {}, notes: [] });
  assert.equal(text, '未识别项目类型，请手动填写');
});

test('多服务项目提示 README 命令未整体应用', () => {
  const text = describeDetection({
    runtime: 'Workspace',
    sources: { setup: 'structure', start: 'structure' },
    readme: { file: 'README.md', evidence: [{ command: 'npm run dev' }] },
    services: [{ id: 'web' }, { id: 'api' }],
  });
  assert.match(text, /README\.md/);
  assert.match(text, /多服务/);
});

test('空输入安全返回', () => {
  assert.equal(describeDetection(null), '未识别项目类型，请手动填写');
});
