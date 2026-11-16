'use strict';

const tools = require('./tools');

/**
 * 数据库环境：识别项目需要哪种数据库、本机是否装了对应服务，
 * 并把用户输入的口令拼成连接串交给启动器注入。
 * 口令只保存在内存里，不写 profiles.json。
 */

const ENGINES = {
  postgres: {
    label: 'PostgreSQL',
    port: 5432,
    user: 'postgres',
    database: 'postgres',
    envKey: 'DATABASE_URL',
    passwordEnv: 'PGPASSWORD',
    passwordRequired: true,
    servicePattern: /postgres/i,
  },
  mysql: {
    label: 'MySQL',
    port: 3306,
    user: 'root',
    database: 'mysql',
    envKey: 'DATABASE_URL',
    passwordEnv: 'MYSQL_PWD',
    passwordRequired: true,
    servicePattern: /mysql|mariadb/i,
  },
  redis: {
    label: 'Redis',
    port: 6379,
    user: '',
    database: '0',
    envKey: 'REDIS_URL',
    passwordEnv: 'REDISCLI_AUTH',
    passwordRequired: false,
    servicePattern: /redis|valkey/i,
  },
  mongo: {
    label: 'MongoDB',
    port: 27017,
    user: 'admin',
    database: 'admin',
    envKey: 'MONGODB_URL',
    passwordEnv: 'MONGO_PWD',
    passwordRequired: true,
    servicePattern: /mongo/i,
  },
};

const ENGINE_HINTS = [
  ['postgres', /postgres(?:ql)?|psql|pg_ctl|5432/i],
  ['mysql', /mysql|mariadb|3306/i],
  ['redis', /redis|valkey|6379/i],
  ['mongo', /mongo(?:db)?|27017/i],
];

const CONNECTION_HINTS = [
  ['postgres', /(?:postgres|postgresql):\/\//i],
  ['mysql', /mysql:\/\//i],
  ['redis', /redis:\/\//i],
  ['mongo', /mongodb(?:\+srv)?:\/\//i],
];

function engineFromText(text) {
  const source = String(text || '');
  for (const [engine, pattern] of ENGINE_HINTS) {
    if (pattern.test(source)) return engine;
  }
  return null;
}

/** 只认真正的连接串，避免 README 里顺带提一句 PostgreSQL 就误报数据库。 */
function engineFromConnectionText(text) {
  const source = String(text || '');
  for (const [engine, pattern] of CONNECTION_HINTS) {
    if (pattern.test(source)) return engine;
  }
  return null;
}

function engineFromCompose(text) {
  const source = String(text || '');
  const imageLines = source.split(/\r?\n/).filter((line) => /^\s*image\s*:/.test(line));
  for (const line of imageLines) {
    const engine = engineFromText(line);
    if (engine) return engine;
  }
  return null;
}

function engineFromServices(services) {
  const list = Array.isArray(services) ? services : [];
  for (const service of list) {
    if (service.role !== 'database') continue;
    const engine = engineFromText(`${service.name} ${service.startCommand}`);
    if (engine) return engine;
  }
  return null;
}

function portFromText(text, fallback) {
  const match = /(\d{4,5})/.exec(String(text || ''));
  if (!match) return fallback;
  const port = Number.parseInt(match[1], 10);
  return port >= 1 && port <= 65535 ? port : fallback;
}

/** 解析 `sc query state= all` 输出，返回本机数据库服务。 */
function parseWindowsServices(output) {
  const services = [];
  let current = null;

  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    const name = /^SERVICE_NAME:\s*(.+)$/i.exec(line);
    if (name) {
      if (current) services.push(current);
      current = { name: name[1].trim(), state: '', running: false };
      continue;
    }
    if (!current) continue;
    const state = /^STATE\s*:\s*\d+\s+(.+)$/i.exec(line);
    if (state) {
      current.state = state[1].trim();
      current.running = /RUNNING/i.test(current.state);
    }
  }
  if (current) services.push(current);
  return services;
}

/** 枚举本机服务并挑出与引擎匹配的数据库服务。 */
async function findLocalServices({ exec = tools.defaultExec, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const result = await exec('sc', ['query', 'state=', 'all'], { timeoutMs: 15000 });
  if (!result.ok) return [];
  return parseWindowsServices(result.stdout).filter((service) =>
    ENGINE_HINTS.some(([, pattern]) => pattern.test(service.name)),
  );
}

function serviceForEngine(services, engine) {
  const spec = ENGINES[engine];
  if (!spec) return null;
  const matched = (services || []).filter((service) => spec.servicePattern.test(service.name));
  if (matched.length === 0) return null;
  return matched.find((service) => service.running) || matched[0];
}

/**
 * 判断项目需要哪种数据库。
 * 优先看 docker-compose 的镜像，其次看数据库服务的启动命令，最后看 README / .env 提示。
 */
async function detectDatabase({
  composeText = '',
  readmeText = '',
  services = [],
  envText = '',
  exec = tools.defaultExec,
  platform = process.platform,
} = {}) {
  const engine =
    engineFromCompose(composeText) ||
    engineFromServices(services) ||
    engineFromConnectionText(`${readmeText}\n${envText}`);

  if (!engine) return null;
  const spec = ENGINES[engine];
  const dbService = (services || []).find((service) => service.role === 'database');
  const container = Boolean(dbService && /docker/i.test(dbService.startCommand || ''));
  const port = (dbService && dbService.port) || spec.port;
  const localServices = container ? [] : await findLocalServices({ exec, platform });
  const local = serviceForEngine(localServices, engine);

  return {
    engine,
    label: spec.label,
    port,
    container,
    user: spec.user,
    database: spec.database,
    envKey: spec.envKey,
    passwordEnv: spec.passwordEnv,
    passwordRequired: spec.passwordRequired,
    local: local ? { name: local.name, running: local.running, state: local.state } : null,
    localCandidates: localServices.map((service) => service.name),
    source: engineFromCompose(composeText) ? 'docker-compose' : engineFromServices(services) ? 'services' : 'readme',
  };
}

function encode(value) {
  return encodeURIComponent(String(value ?? ''));
}

/** 根据引擎拼连接串。redis 没有用户名时用 `:password@` 形式。 */
function buildDatabaseUrl(descriptor, { host = '127.0.0.1', user, password, database } = {}) {
  const spec = ENGINES[descriptor.engine];
  if (!spec) throw new Error(`不支持的数据库类型: ${descriptor.engine}`);
  const name = database || descriptor.database || spec.database;
  const auth = user || descriptor.user || spec.user;
  const port = descriptor.port || spec.port;
  const secret = password ? encode(password) : '';

  if (descriptor.engine === 'postgres') {
    return `postgresql://${encode(auth)}:${secret}@${host}:${port}/${encode(name)}`;
  }
  if (descriptor.engine === 'mysql') {
    return `mysql://${encode(auth)}:${secret}@${host}:${port}/${encode(name)}`;
  }
  if (descriptor.engine === 'redis') {
    const dbIndex = /^\d+$/.test(String(name)) ? name : '0';
    return secret ? `redis://:${secret}@${host}:${port}/${dbIndex}` : `redis://${host}:${port}/${dbIndex}`;
  }
  if (descriptor.engine === 'mongo') {
    return `mongodb://${encode(auth)}:${secret}@${host}:${port}/${encode(name)}`;
  }
  throw new Error(`不支持的数据库类型: ${descriptor.engine}`);
}

/** 连接串之外再补一个引擎惯用的口令变量（psql / mysql 客户端会直接读）。 */
function buildEnvVars(descriptor, secret) {
  const spec = ENGINES[descriptor.engine] || {};
  const url = buildDatabaseUrl(descriptor, secret);
  const vars = [{ key: descriptor.envKey || spec.envKey || 'DATABASE_URL', value: url }];
  const passwordEnv = descriptor.passwordEnv || spec.passwordEnv;
  if (secret.password && passwordEnv) {
    vars.push({ key: passwordEnv, value: secret.password });
  }
  return vars;
}

/** 启动本机数据库服务（Windows 服务）。需要管理员权限时会返回可读提示。 */
async function startLocalService(name, { exec = tools.defaultExec } = {}) {
  if (!name) return { ok: false, message: '没有找到本机数据库服务' };
  const result = await exec('net', ['start', name], { timeoutMs: 30000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.ok) return { ok: true, message: `已启动 ${name}`, output };
  if (/已经启动|already been started|服务正在启动/i.test(output)) {
    return { ok: true, message: `${name} 已经在运行`, output };
  }
  if (/拒绝访问|access is denied|error 5/i.test(output)) {
    return { ok: false, message: `启动 ${name} 需要管理员权限，请手动执行：net start "${name}"`, output };
  }
  return { ok: false, message: output || `启动 ${name} 失败`, output };
}

module.exports = {
  ENGINES,
  engineFromText,
  engineFromCompose,
  engineFromServices,
  parseWindowsServices,
  findLocalServices,
  detectDatabase,
  buildDatabaseUrl,
  buildEnvVars,
  startLocalService,
};
