'use strict';

const fs = require('node:fs');
const path = require('node:path');

function exists(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

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

function globFirst(dir, ext) {
  try {
    return fs.readdirSync(dir).find((name) => path.extname(name).toLowerCase() === ext) || null;
  } catch {
    return null;
  }
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const DATABASE_IMAGE_HINTS = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mongo',
  'mongodb',
  'redis',
  'valkey',
  'couchdb',
  'clickhouse',
];

function findComposeFile(dir) {
  return COMPOSE_FILES.find((name) => exists(dir, name)) || null;
}

function roleForImage(image) {
  const value = String(image || '').toLowerCase();
  return DATABASE_IMAGE_HINTS.some((hint) => value.includes(hint)) ? 'database' : 'app';
}

function parsePort(value) {
  const clean = String(value).split('/')[0];
  const parts = clean.split(':');
  const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const port = Number.parseInt(candidate, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * 极简 docker-compose 解析：只提取服务名、镜像、宿主机端口、depends_on。
 * 不引入 YAML 依赖，只支持缩进块写法与行内数组写法。
 */
function parseComposeServices(text) {
  const lines = String(text || '').split(/\r?\n/);
  const services = [];
  let inServices = false;
  let serviceIndent = null;
  let current = null;
  let section = null;

  const createService = (name) => ({
    id: name,
    name,
    role: 'app',
    cwd: '.',
    setupCommand: '',
    startCommand: `docker compose up -d ${name}`,
    port: null,
    envVars: [],
    dependsOn: [],
    image: '',
  });

  const finish = () => {
    if (!current) return;
    current.role = roleForImage(current.image);
    delete current.image;
    services.push(current);
    current = null;
    section = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      finish();
      inServices = /^services:\s*$/.test(trimmed);
      serviceIndent = null;
      continue;
    }
    if (!inServices) continue;

    if (serviceIndent === null) {
      const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/);
      if (!match) continue;
      serviceIndent = indent;
      current = createService(match[1]);
      continue;
    }

    if (indent === serviceIndent) {
      finish();
      const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/);
      if (match) current = createService(match[1]);
      continue;
    }

    if (indent <= serviceIndent || !current) continue;

    if (trimmed.startsWith('-')) {
      const value = trimmed.slice(1).trim().replace(/^["']|["']$/g, '');
      if (section === 'ports') {
        const port = parsePort(value);
        if (port) current.port = port;
      } else if (section === 'depends_on') {
        current.dependsOn.push(value);
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();

    if (key === 'image') {
      current.image = value;
      section = null;
    } else if (key === 'build') {
      current.image = '';
      section = null;
    } else if (key === 'ports') {
      section = 'ports';
    } else if (key === 'depends_on') {
      section = 'depends_on';
      if (value.startsWith('[') && value.endsWith(']')) {
        for (const item of value.slice(1, -1).split(',')) {
          const dep = item.trim().replace(/^["']|["']$/g, '');
          if (dep) current.dependsOn.push(dep);
        }
      }
    } else {
      section = null;
    }
  }

  finish();
  return services;
}

function detectNode(dir, result) {
  if (!exists(dir, 'package.json')) return false;
  const pkg = readJson(dir, 'package.json') || {};
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

  let pm = 'npm';
  if (exists(dir, 'pnpm-lock.yaml')) pm = 'pnpm';
  else if (exists(dir, 'yarn.lock')) pm = 'yarn';
  else if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) pm = 'bun';

  result.runtime = 'Node.js';
  result.setupCommand = pm === 'npm' ? 'npm install' : `${pm} install`;

  const script = ['dev', 'start', 'preview', 'serve'].find((name) => scripts[name]);
  if (script) {
    result.startCommand = pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
  } else {
    result.notes.push('package.json 里没有 dev/start 脚本，请手动填写启动命令');
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const framework = [
    ['next', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['vite', 'Vite'],
    ['@nestjs/core', 'NestJS'],
    ['electron', 'Electron'],
    ['react', 'React'],
    ['vue', 'Vue'],
  ].find(([name]) => deps[name]);
  if (framework) result.notes.push(`识别到 ${framework[1]} 项目`);
  if (pkg.packageManager) result.notes.push(`packageManager: ${pkg.packageManager}`);
  return true;
}

function detectPython(dir, result) {
  const hasRequirements = exists(dir, 'requirements.txt');
  const hasPyproject = exists(dir, 'pyproject.toml');
  const hasPipfile = exists(dir, 'Pipfile');
  const hasManage = exists(dir, 'manage.py');
  if (!hasRequirements && !hasPyproject && !hasPipfile && !hasManage) return false;

  result.runtime = 'Python';
  const pyproject = readText(dir, 'pyproject.toml');

  if (exists(dir, 'uv.lock')) {
    result.setupCommand = 'uv sync';
  } else if (hasPyproject && pyproject.includes('[tool.poetry]')) {
    result.setupCommand = 'poetry install';
  } else if (hasPipfile) {
    result.setupCommand = 'pipenv install';
  } else if (hasRequirements) {
    result.setupCommand = 'pip install -r requirements.txt';
  } else if (hasPyproject) {
    result.setupCommand = 'pip install -e .';
  }

  if (hasManage) {
    result.startCommand = 'python manage.py runserver';
    result.notes.push('识别到 Django 项目');
  } else if (exists(dir, 'app.py')) {
    result.startCommand = 'python app.py';
  } else if (exists(dir, 'main.py')) {
    result.startCommand = 'python main.py';
  } else if (hasPyproject && pyproject.includes('[tool.poetry]')) {
    result.notes.push('Poetry 项目，启动命令请按 entrypoint 填写');
  }
  return true;
}

function detectRust(dir, result) {
  if (!exists(dir, 'Cargo.toml')) return false;
  result.runtime = 'Rust';
  result.setupCommand = 'cargo build';
  result.startCommand = 'cargo run';
  return true;
}

function detectGo(dir, result) {
  if (!exists(dir, 'go.mod')) return false;
  result.runtime = 'Go';
  result.setupCommand = 'go mod download';
  result.startCommand = 'go run .';
  return true;
}

function detectDotnet(dir, result) {
  const sln = globFirst(dir, '.sln');
  const csproj = globFirst(dir, '.csproj');
  if (!sln && !csproj) return false;
  result.runtime = '.NET';
  result.setupCommand = 'dotnet restore';
  result.startCommand = 'dotnet run';
  return true;
}

function detectDocker(dir, result) {
  const composeFile = findComposeFile(dir);
  if (!composeFile) return false;
  result.runtime = 'Docker Compose';
  result.startCommand = 'docker compose up';
  result.notes.push('容器项目，停止时请用 docker compose down');
  return true;
}

function detectRuby(dir, result) {
  if (!exists(dir, 'Gemfile')) return false;
  result.runtime = 'Ruby';
  result.setupCommand = 'bundle install';
  const gemfile = readText(dir, 'Gemfile');
  if (gemfile.includes("'rails'") || gemfile.includes('"rails"') || exists(dir, 'bin/rails')) {
    result.startCommand = 'bundle exec rails server';
    result.notes.push('识别到 Rails 项目');
  }
  return true;
}

function detectJava(dir, result) {
  if (exists(dir, 'pom.xml')) {
    result.runtime = 'Java (Maven)';
    result.setupCommand = 'mvn install -DskipTests';
    const pom = readText(dir, 'pom.xml');
    result.startCommand = pom.includes('spring-boot') ? 'mvn spring-boot:run' : '';
    return true;
  }
  if (exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts')) {
    result.runtime = 'Java (Gradle)';
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    result.setupCommand = exists(dir, 'gradlew') ? `${wrapper} build -x test` : 'gradle build -x test';
    result.startCommand = exists(dir, 'gradlew') ? `${wrapper} bootRun` : 'gradle bootRun';
    return true;
  }
  return false;
}

function detectPhp(dir, result) {
  if (!exists(dir, 'composer.json')) return false;
  result.runtime = 'PHP';
  result.setupCommand = 'composer install';
  if (exists(dir, 'artisan')) {
    result.startCommand = 'php artisan serve';
    result.notes.push('识别到 Laravel 项目');
  }
  return true;
}

/**
 * 根据目录特征推断安装 / 启动命令。不执行任何命令，纯只读探测。
 * @param {string} dir 项目绝对路径
 */
function detectProject(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('请先选择项目目录');
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录: ${dir}`);

  const result = {
    runtime: null,
    setupCommand: '',
    startCommand: '',
    services: [],
    notes: [],
    dir,
  };

  const detectors = [
    detectNode,
    detectPython,
    detectDocker,
    detectRust,
    detectGo,
    detectDotnet,
    detectJava,
    detectRuby,
    detectPhp,
  ];

  for (const detector of detectors) {
    if (detector(dir, result)) break;
  }

  const composeFile = findComposeFile(dir);
  if (composeFile) {
    const composeServices = parseComposeServices(readText(dir, composeFile));
    if (composeServices.length > 0) {
      result.services = composeServices;
      const dataIds = composeServices.filter((service) => service.role === 'database').map((service) => service.id);

      if (result.runtime && result.runtime !== 'Docker Compose') {
        const appId = composeServices.some((service) => service.id === 'main') ? 'main-app' : 'main';
        result.services.push({
          id: appId,
          name: path.basename(dir),
          role: 'app',
          cwd: '.',
          setupCommand: result.setupCommand,
          startCommand: result.startCommand,
          port: null,
          envVars: [],
          dependsOn: dataIds,
        });
        result.notes.push(`已把 ${dataIds.length} 个数据库服务设为主应用的依赖`);
      }
    }
  }

  if (!result.runtime) {
    result.notes.push('未识别项目类型，请手动填写安装与启动命令');
  }
  return result;
}

module.exports = { detectProject, parseComposeServices, parsePort, roleForImage };
