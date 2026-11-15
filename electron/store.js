'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, profiles: [], activeId: null, setupAt: {} };
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeEnvVars(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      key: normalizeString(item.key).trim(),
      value: normalizeString(item.value),
    }))
    .filter((item) => item.key.length > 0);
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const dir = normalizeString(raw.dir).trim();
  if (!dir) return null;
  return {
    id: normalizeString(raw.id) || crypto.randomUUID(),
    name: normalizeString(raw.name).trim() || path.basename(dir),
    dir,
    shell: raw.shell === 'powershell' ? 'powershell' : 'cmd',
    setupCommand: normalizeString(raw.setupCommand),
    startCommand: normalizeString(raw.startCommand),
    stopCommand: normalizeString(raw.stopCommand),
    envVars: normalizeEnvVars(raw.envVars),
    syncDotEnv: raw.syncDotEnv === true,
    autoSetup: raw.autoSetup !== false,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : null,
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.map(normalizeProfile).filter(Boolean)
    : [];
  const ids = new Set(profiles.map((profile) => profile.id));
  const activeId = ids.has(raw.activeId) ? raw.activeId : null;
  const setupAt = {};
  if (raw.setupAt && typeof raw.setupAt === 'object') {
    for (const [id, ts] of Object.entries(raw.setupAt)) {
      if (ids.has(id) && Number.isFinite(ts)) setupAt[id] = ts;
    }
  }
  return { version: STATE_VERSION, profiles, activeId, setupAt };
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'profiles.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this.#read();
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}.json`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* 备份失败不阻塞启动 */
      }
      return emptyState();
    }
  }

  save() {
    const payload = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  getState() {
    return this.state;
  }

  list() {
    return this.state.profiles;
  }

  find(id) {
    return this.state.profiles.find((profile) => profile.id === id) || null;
  }

  saveProfile(input) {
    const profile = normalizeProfile(input);
    if (!profile) throw new Error('项目路径不能为空');

    const index = this.state.profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) {
      const existing = this.state.profiles[index];
      profile.createdAt = existing.createdAt;
      if (profile.lastUsedAt === null) profile.lastUsedAt = existing.lastUsedAt;
      this.state.profiles[index] = profile;
    } else {
      this.state.profiles.push(profile);
    }

    if (profile.lastUsedAt === null) {
      profile.lastUsedAt = Date.now();
    }
    this.save();
    return profile;
  }

  remove(id) {
    this.state.profiles = this.state.profiles.filter((profile) => profile.id !== id);
    if (this.state.activeId === id) this.state.activeId = null;
    delete this.state.setupAt[id];
    this.save();
  }

  setActive(id) {
    const profile = id ? this.find(id) : null;
    this.state.activeId = profile ? profile.id : null;
    if (profile) profile.lastUsedAt = Date.now();
    this.save();
    return this.state.activeId;
  }

  markSetup(id) {
    this.state.setupAt[id] = Date.now();
    this.save();
  }

  isSetup(id) {
    return Boolean(this.state.setupAt[id]);
  }
}

module.exports = { Store, normalizeState, normalizeProfile, emptyState };
