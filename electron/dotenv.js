'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = '.env.devdock.state.json';
const BACKUP_FILE = '.env.devdock.bak';

function statePath(dir) {
  return path.join(dir, STATE_FILE);
}

function backupPath(dir) {
  return path.join(dir, BACKUP_FILE);
}

function envPath(dir) {
  return path.join(dir, '.env');
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(dir, state) {
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2), 'utf8');
}

function formatValue(value) {
  const text = String(value ?? '').replace(/\r?\n/g, '\\n');
  if (/^[^\s#"'`]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mergeEnvText(text, envVars) {
  const remaining = new Map(
    envVars
      .filter((item) => item && item.key)
      .map((item) => [String(item.key).trim(), String(item.value ?? '')]),
  );
  if (remaining.size === 0) return text;

  const lines = text ? text.split(/\r?\n/) : [];
  const merged = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${formatValue(value)}`;
  });

  while (merged.length > 0 && merged[merged.length - 1].trim() === '') merged.pop();
  for (const [key, value] of remaining) {
    merged.push(`${key}=${formatValue(value)}`);
  }
  return `${merged.join('\n')}\n`;
}

/**
 * 把环境变量合并进项目 .env（首次调用会备份原始文件）。
 * @returns {{ applied: boolean, backup: string|null, existed: boolean }}
 */
function apply(dir, envVars) {
  const vars = Array.isArray(envVars) ? envVars.filter((item) => item && item.key) : [];
  if (vars.length === 0) return { applied: false, backup: null, existed: false };

  const file = envPath(dir);
  const backup = backupPath(dir);
  let state = readState(dir);

  if (!state) {
    const existed = fs.existsSync(file);
    if (existed) fs.copyFileSync(file, backup);
    state = { existed, createdAt: Date.now() };
    writeState(dir, state);
  }

  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, mergeEnvText(current, vars), 'utf8');
  return { applied: true, backup: state.existed ? backup : null, existed: state.existed };
}

/**
 * 还原被 apply 改动过的 .env。重复调用安全。
 * @returns {{ restored: boolean, existed: boolean }}
 */
function restore(dir) {
  const state = readState(dir);
  if (!state) return { restored: false, existed: false };

  const file = envPath(dir);
  const backup = backupPath(dir);
  if (state.existed) {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, file);
      fs.rmSync(backup, { force: true });
    }
  } else {
    fs.rmSync(file, { force: true });
  }

  fs.rmSync(statePath(dir), { force: true });
  return { restored: true, existed: Boolean(state.existed) };
}

/**
 * 生成只用于子进程的环境对象，不影响宿主进程。
 */
function toProcessEnv(baseEnv, envVars) {
  const env = { ...baseEnv };
  for (const item of envVars || []) {
    if (!item || !item.key) continue;
    env[String(item.key).trim()] = String(item.value ?? '');
  }
  return env;
}

module.exports = { apply, restore, mergeEnvText, toProcessEnv, STATE_FILE, BACKUP_FILE };
