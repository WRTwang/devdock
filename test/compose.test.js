'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseComposeServices, detectProject } = require('../electron/detector');

const COMPOSE = `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: dev
  cache:
    image: redis:7
    ports:
      - "6379:6379"
  api:
    build: ./server
    ports:
      - "4000:4000"
    depends_on:
      - db
`;

test('解析 compose 中的多个服务并识别数据库', () => {
  const services = parseComposeServices(COMPOSE);
  assert.equal(services.length, 3);
  assert.deepEqual(services.map((service) => service.id), ['db', 'cache', 'api']);
  assert.equal(services[0].role, 'database');
  assert.equal(services[1].role, 'database');
});

test('compose 端口取宿主机一侧', () => {
  const services = parseComposeServices(COMPOSE);
  assert.equal(services[0].port, 5432);
  assert.equal(services[1].port, 6379);
  assert.equal(services[2].port, 4000);
});

test('depends_on 转成 dependsOn', () => {
  const services = parseComposeServices(COMPOSE);
  const api = services.find((service) => service.id === 'api');
  assert.deepEqual(api.dependsOn, ['db']);
});

test('每个服务生成独立的 compose 启动命令', () => {
  const services = parseComposeServices(COMPOSE);
  assert.equal(services[0].startCommand, 'docker compose up -d db');
  assert.equal(services[2].startCommand, 'docker compose up -d api');
});

test('带 IP 前缀的端口写法也能解析', () => {
  const services = parseComposeServices(`services:
  db:
    image: mysql:8
    ports:
      - "127.0.0.1:3307:3306"
`);
  assert.equal(services[0].port, 3307);
  assert.equal(services[0].role, 'database');
});

test('没有 services 段返回空列表', () => {
  assert.deepEqual(parseComposeServices('version: "3"\n'), []);
  assert.deepEqual(parseComposeServices(''), []);
});

test('未知镜像映射为 app 角色', () => {
  const services = parseComposeServices(`services:
  custom:
    image: ghcr.io/acme/worker:1
`);
  assert.equal(services[0].role, 'app');
});

test('项目同时有 package.json 和 compose 时，主应用依赖数据库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-compose-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), COMPOSE, 'utf8');

  const result = detectProject(dir);
  const ids = result.services.map((service) => service.id);
  assert.ok(ids.includes('db'));
  assert.ok(ids.includes('main'));

  const main = result.services.find((service) => service.id === 'main');
  assert.equal(main.startCommand, 'npm run dev');
  assert.ok(main.dependsOn.includes('db'));
});

test('只有 compose 的项目仍返回 docker compose 启动命令', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-compose-only-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), COMPOSE, 'utf8');

  const result = detectProject(dir);
  assert.equal(result.runtime, 'Docker Compose');
  assert.equal(result.startCommand, 'docker compose up');
  assert.equal(result.services.length, 3);
});
