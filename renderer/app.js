'use strict';

const api = window.devdock;
const $ = (id) => document.getElementById(id);

const state = {
  profiles: [],
  activeId: null,
  setupAt: {},
  running: {},
  selectedId: null,
  tab: 'config',
  editingId: null,
  busy: {},
  detected: {},
  logs: new Map(), // projectId -> { chunks: [], logFile: string|null, bytes: number }
  autoScroll: true,
  appVersion: '',
};

/* ---------------- 工具 ---------------- */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function timeAgo(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function shortPath(dir, depth = 2) {
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  if (parts.length <= depth) return dir;
  return '…\\' + parts.slice(-depth).join('\\');
}

function toast(message, type = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, type === 'error' ? 6000 : 3200);
}

function profileById(id) {
  return state.profiles.find((profile) => profile.id === id) || null;
}

function selectedProfile() {
  return profileById(state.selectedId);
}

function isRunning(id) {
  return Boolean(state.running[id] && state.running[id].running);
}

/* ---------------- 状态同步 ---------------- */

function applyState(data) {
  state.profiles = data.profiles || [];
  state.activeId = data.activeId || null;
  state.setupAt = data.setupAt || {};
  state.running = data.running || {};
  state.appVersion = data.appVersion || '';
  if (!state.selectedId || !profileById(state.selectedId)) {
    state.selectedId = state.activeId || (state.profiles[0] ? state.profiles[0].id : null);
  }
}

async function refresh() {
  const data = await api.list();
  applyState(data);
  renderAll();
}

function renderAll() {
  renderSidebar();
  renderDetail();
}

/* ---------------- 侧栏 ---------------- */

function renderSidebar() {
  const list = $('project-list');
  const scrollTop = list.scrollTop;
  $('project-count').textContent = String(state.profiles.length);

  if (state.profiles.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = state.profiles
    .map((profile) => {
      const running = isRunning(profile.id);
      const active = state.activeId === profile.id;
      const selected = state.selectedId === profile.id;
      const dotClass = running ? 'running' : active ? 'active' : '';
      const detected = state.detected[profile.id];
      const tag = detected && detected.runtime ? detected.runtime : '未识别';
      return `
        <div class="project-item ${selected ? 'selected' : ''}" data-id="${profile.id}" title="${escapeHtml(profile.dir)}">
          <span class="status-dot ${dotClass}"></span>
          <div class="pi-body">
            <div class="pi-name">${escapeHtml(profile.name)}</div>
            <div class="pi-path" title="${escapeHtml(profile.dir)}">${escapeHtml(shortPath(profile.dir))}</div>
            <div class="pi-meta">
              <span class="mini-tag">${escapeHtml(tag)}</span>
              ${running ? '<span class="mini-tag live">运行中</span>' : ''}
              ${active && !running ? '<span class="mini-tag">当前环境</span>' : ''}
            </div>
          </div>
        </div>`;
    })
    .join('');

  list.scrollTop = scrollTop;

  list.querySelectorAll('.project-item').forEach((node) => {
    node.addEventListener('click', () => selectProfile(node.dataset.id));
  });
}

function selectProfile(id) {
  state.selectedId = id;
  state.tab = 'config';
  renderAll();
  syncTabs();
  ensureDetection(id);
}

/* ---------------- 详情 ---------------- */

function renderDetail() {
  const profile = selectedProfile();
  const empty = !profile;
  $('empty-state').hidden = !empty;
  $('detail').hidden = empty;
  if (!profile) {
    renderActivePill();
    return;
  }

  const running = isRunning(profile.id);
  const active = state.activeId === profile.id;

  $('project-name').textContent = profile.name;
  $('project-path').textContent = profile.dir;
  $('status-dot').className = `status-dot ${running ? 'running' : active ? 'active' : ''}`;
  $('live-badge').hidden = !running;

  const detected = state.detected[profile.id];
  const runtimeBadge = $('runtime-badge');
  if (detected && detected.runtime) {
    runtimeBadge.hidden = false;
    runtimeBadge.textContent = detected.runtime;
  } else {
    runtimeBadge.hidden = true;
  }

  $('btn-activate').hidden = active;
  $('btn-stop').hidden = !running && !state.busy[profile.id];
  $('btn-start').disabled = running || Boolean(state.busy[profile.id]);
  $('btn-setup').disabled = Boolean(state.busy[profile.id]);

  renderConfig(profile);
  renderActivePill();
}

function renderActivePill() {
  const pill = $('active-pill');
  const profile = profileById(state.activeId);
  if (!profile) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  $('active-name').textContent = profile.name;
}

function renderConfig(profile) {
  const detected = state.detected[profile.id] || {};
  $('cfg-runtime').textContent = detected.runtime || '待检测';
  $('cfg-shell').textContent = profile.shell === 'powershell' ? 'PowerShell' : 'CMD';
  $('cfg-setup').textContent = state.setupAt[profile.id]
    ? `已就绪 · ${timeAgo(state.setupAt[profile.id])}`
    : '未搭建';
  $('cfg-last-used').textContent = fmtDateTime(profile.lastUsedAt);

  setCommand('cfg-setup-cmd', profile.setupCommand);
  setCommand('cfg-start-cmd', profile.startCommand);
  setCommand('cfg-stop-cmd', profile.stopCommand);

  const envBox = $('cfg-env-vars');
  if (profile.envVars.length === 0) {
    envBox.innerHTML = '<span class="mini-tag">未设置环境变量</span>';
  } else {
    envBox.innerHTML = profile.envVars
      .map(
        (item) =>
          `<span class="env-chip" title="${escapeHtml(`${item.key}=${item.value}`)}"><b>${escapeHtml(
            item.key,
          )}</b>=${escapeHtml(item.value)}</span>`,
      )
      .join('');
  }

  const hint = $('cfg-env-hint');
  hint.hidden = !profile.syncDotEnv;
  hint.textContent = profile.syncDotEnv
    ? '已开启 .env 同步：启动时写入项目 .env，停止或切换环境时自动还原。'
    : '';

  const notes = $('cfg-notes');
  if (detected.notes && detected.notes.length) {
    notes.innerHTML = detected.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  } else {
    notes.innerHTML = '<li>暂无检测备注</li>';
  }
}

function setCommand(id, command) {
  const node = $(id);
  if (command) {
    node.textContent = command;
    node.classList.remove('empty');
  } else {
    node.textContent = '未配置';
    node.classList.add('empty');
  }
}

function ensureDetection(id) {
  const profile = profileById(id);
  if (!profile || state.detected[id]) return;
  api
    .detect(profile.dir)
    .then((result) => {
      state.detected[id] = result;
      if (state.selectedId === id) {
        renderDetail();
      }
      renderSidebar();
    })
    .catch((error) => {
      state.detected[id] = { runtime: null, notes: [error.message] };
      if (state.selectedId === id) renderDetail();
    });
}

/* ---------------- 日志 ---------------- */

function logStore(projectId) {
  let store = state.logs.get(projectId);
  if (!store) {
    store = { chunks: [], logFile: null, bytes: 0 };
    state.logs.set(projectId, store);
  }
  return store;
}

function appendLog(payload) {
  const { projectId, stream, chunk, logFile } = payload;
  if (!projectId || !chunk) return;
  const store = logStore(projectId);
  if (logFile) store.logFile = logFile;

  store.chunks.push({ stream, text: chunk });
  store.bytes += chunk.length;
  while (store.bytes > 1_500_000 && store.chunks.length > 1) {
    const removed = store.chunks.shift();
    store.bytes -= removed.text.length;
  }

  if (state.selectedId === projectId && state.tab === 'logs') {
    appendLogDom(stream, chunk);
  }
}

function lineClass(stream) {
  if (stream === 'stderr') return 'line-stderr';
  if (stream === 'meta') return 'line-meta';
  if (stream === 'system') return 'line-system';
  return '';
}

function appendLogDom(stream, text) {
  const output = $('log-output');
  const placeholder = output.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const span = document.createElement('span');
  span.className = lineClass(stream);
  span.textContent = text;
  output.appendChild(span);

  if (state.autoScroll) output.scrollTop = output.scrollHeight;
}

function renderLogs() {
  const output = $('log-output');
  output.innerHTML = '';
  const store = state.logs.get(state.selectedId);
  if (!store || store.chunks.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'placeholder';
    placeholder.textContent = '等待输出… 点击「启动」或「搭环境」后日志会显示在这里。';
    output.appendChild(placeholder);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const chunk of store.chunks) {
    const span = document.createElement('span');
    span.className = lineClass(chunk.stream);
    span.textContent = chunk.text;
    fragment.appendChild(span);
  }
  output.appendChild(fragment);
  output.scrollTop = output.scrollHeight;
}

function syncTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === state.tab);
  });
  $('panel-config').hidden = state.tab !== 'config';
  $('panel-logs').hidden = state.tab !== 'logs';
  $('log-tools').hidden = state.tab !== 'logs';
  if (state.tab === 'logs') renderLogs();
}

/* ---------------- 动作 ---------------- */

async function activate(profile) {
  await api.activate(profile.id);
  state.activeId = profile.id;
  renderAll();
  toast(`已切换到 ${profile.name} 的环境`, 'success');
}

async function start(profile) {
  state.busy[profile.id] = 'start';
  renderDetail();
  try {
    await api.start(profile.id);
    state.tab = 'logs';
    syncTabs();
  } catch (error) {
    delete state.busy[profile.id];
    renderDetail();
    toast(error.message, 'error');
  }
}

async function setup(profile) {
  state.busy[profile.id] = 'setup';
  renderDetail();
  try {
    await api.setup(profile.id);
    state.tab = 'logs';
    syncTabs();
    toast('开始搭建环境…');
  } catch (error) {
    delete state.busy[profile.id];
    renderDetail();
    toast(error.message, 'error');
  }
}

async function stop(profile) {
  try {
    await api.stop(profile.id);
    toast(`已停止 ${profile.name}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function remove(profile) {
  if (!window.confirm(`确定删除「${profile.name}」吗？\n只会删除 DevDock 里的档案，不会动项目文件。`)) return;
  try {
    await api.remove(profile.id);
    state.logs.delete(profile.id);
    delete state.detected[profile.id];
    if (state.selectedId === profile.id) state.selectedId = null;
    await refresh();
    toast('档案已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- 编辑器 ---------------- */

function openEditor(profile) {
  state.editingId = profile ? profile.id : null;
  $('editor-title').textContent = profile ? '编辑项目' : '新建项目';
  $('btn-editor-delete').hidden = !profile;
  $('dir-error').hidden = true;
  $('detect-hint').textContent = '';
  $('detect-hint').className = 'detect-hint';

  $('f-name').value = profile ? profile.name : '';
  $('f-dir').value = profile ? profile.dir : '';
  $('f-shell').value = profile ? profile.shell : 'cmd';
  $('f-setup').value = profile ? profile.setupCommand : '';
  $('f-start').value = profile ? profile.startCommand : '';
  $('f-stop').value = profile ? profile.stopCommand : '';
  $('f-auto-setup').checked = profile ? profile.autoSetup : true;
  $('f-sync-env').checked = profile ? profile.syncDotEnv : false;

  const envEditor = $('env-editor');
  envEditor.innerHTML = '';
  const vars = profile && profile.envVars.length ? profile.envVars : [];
  vars.forEach((item) => addEnvRow(item.key, item.value));
  if (vars.length === 0) addEnvRow('', '');

  $('editor').showModal();
  setTimeout(() => $('f-dir').focus(), 30);
}

function closeEditor() {
  $('editor').close();
  state.editingId = null;
}

function addEnvRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input class="key-input" type="text" placeholder="KEY" spellcheck="false" autocomplete="off" />
    <input class="value-input" type="text" placeholder="value" spellcheck="false" autocomplete="off" />
    <button type="button" class="btn btn-ghost btn-icon" title="删除">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
      </svg>
    </button>`;
  row.querySelector('.key-input').value = key;
  row.querySelector('.value-input').value = value;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('env-editor').appendChild(row);
}

function collectEnvVars() {
  return [...$('env-editor').querySelectorAll('.env-row')]
    .map((row) => ({
      key: row.querySelector('.key-input').value.trim(),
      value: row.querySelector('.value-input').value,
    }))
    .filter((item) => item.key);
}

async function browse() {
  try {
    const dir = await api.pickDir();
    if (!dir) return;
    $('f-dir').value = dir;
    if (!$('f-name').value.trim()) {
      const name = dir.split(/[\\/]+/).filter(Boolean).pop();
      $('f-name').value = name || '';
    }
    await runDetect();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runDetect() {
  const dir = $('f-dir').value.trim();
  if (!dir) {
    toast('请先填写项目路径', 'error');
    return;
  }
  const hint = $('detect-hint');
  hint.textContent = '检测中…';
  hint.className = 'detect-hint';
  try {
    const result = await api.detect(dir);
    if (result.setupCommand) $('f-setup').value = result.setupCommand;
    if (result.startCommand) $('f-start').value = result.startCommand;
    hint.textContent = result.runtime ? `识别为 ${result.runtime}` : '未识别项目类型';
    hint.className = result.runtime ? 'detect-hint ok' : 'detect-hint';
    if (result.notes.length) toast(result.notes.join(' · '));
    $('dir-error').hidden = true;
  } catch (error) {
    hint.textContent = '';
    $('dir-error').textContent = error.message;
    $('dir-error').hidden = false;
  }
}

async function saveEditor(event) {
  event.preventDefault();
  const dir = $('f-dir').value.trim();
  if (!dir) {
    $('dir-error').textContent = '请填写项目路径';
    $('dir-error').hidden = false;
    $('f-dir').focus();
    return;
  }

  const isNew = !state.editingId;
  const payload = {
    id: state.editingId || undefined,
    name: $('f-name').value.trim(),
    dir,
    shell: $('f-shell').value,
    setupCommand: $('f-setup').value.trim(),
    startCommand: $('f-start').value.trim(),
    stopCommand: $('f-stop').value.trim(),
    envVars: collectEnvVars(),
    autoSetup: $('f-auto-setup').checked,
    syncDotEnv: $('f-sync-env').checked,
  };

  try {
    const saved = await api.save(payload);
    state.selectedId = saved.id;
    delete state.detected[saved.id];
    closeEditor();
    await refresh();
    ensureDetection(saved.id);
    if (isNew) {
      await api.activate(saved.id);
      state.activeId = saved.id;
      renderAll();
      toast(`已创建并切换到 ${saved.name} 的环境`, 'success');
    } else {
      toast('配置已保存', 'success');
    }
  } catch (error) {
    $('dir-error').textContent = error.message;
    $('dir-error').hidden = false;
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btn-new').addEventListener('click', () => openEditor(null));
  $('btn-new-empty').addEventListener('click', () => openEditor(null));
  $('btn-open-logs').addEventListener('click', () => api.openLogs().catch((e) => toast(e.message, 'error')));

  $('btn-activate').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) activate(profile);
  });
  $('btn-start').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) start(profile);
  });
  $('btn-setup').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) setup(profile);
  });
  $('btn-stop').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) stop(profile);
  });
  $('btn-edit').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) openEditor(profile);
  });
  $('btn-delete').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) remove(profile);
  });
  $('btn-open-dir').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) api.openDir(profile.dir).catch((e) => toast(e.message, 'error'));
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      syncTabs();
    });
  });

  $('auto-scroll').addEventListener('change', (event) => {
    state.autoScroll = event.target.checked;
    if (state.autoScroll) {
      const output = $('log-output');
      output.scrollTop = output.scrollHeight;
    }
  });

  $('btn-clear-log').addEventListener('click', () => {
    const store = state.logs.get(state.selectedId);
    if (store) {
      store.chunks = [];
      store.bytes = 0;
    }
    renderLogs();
  });

  $('btn-open-log').addEventListener('click', () => {
    const store = state.logs.get(state.selectedId);
    if (!store || !store.logFile) {
      toast('还没有生成日志文件', 'error');
      return;
    }
    api.revealLog(store.logFile).catch((e) => toast(e.message, 'error'));
  });

  $('editor-close').addEventListener('click', closeEditor);
  $('btn-cancel').addEventListener('click', closeEditor);
  $('editor-form').addEventListener('submit', saveEditor);
  $('btn-browse').addEventListener('click', browse);
  $('btn-detect').addEventListener('click', runDetect);
  $('btn-add-env').addEventListener('click', () => addEnvRow('', ''));

  $('btn-editor-delete').addEventListener('click', async () => {
    const profile = state.editingId ? profileById(state.editingId) : null;
    if (!profile) return;
    closeEditor();
    await remove(profile);
  });

  $('f-dir').addEventListener('change', () => {
    if ($('f-dir').value.trim()) runDetect();
  });

  api.onLog((payload) => appendLog(payload));

  api.onState((payload) => {
    if (payload.type === 'active') {
      state.activeId = payload.activeId;
      renderAll();
      return;
    }
    if (payload.type === 'running') {
      const id = payload.projectId;
      if (payload.running) {
        state.running[id] = { running: true, kinds: [payload.kind] };
        if (payload.kind === 'start') delete state.busy[id];
      } else {
        delete state.running[id];
        if (payload.kind === 'start' || payload.kind === 'setup') delete state.busy[id];
      }
      renderAll();
      return;
    }
    if (payload.type === 'setup-done') {
      delete state.busy[payload.projectId];
      state.setupAt[payload.projectId] = Date.now();
      renderAll();
      toast('环境搭建完成', 'success');
      return;
    }
    if (payload.type === 'error') {
      delete state.busy[payload.projectId];
      renderDetail();
      toast(payload.message, 'error');
      return;
    }
    if (payload.type === 'stopped') {
      delete state.busy[payload.projectId];
      renderAll();
      return;
    }
    if (payload.type === 'phase') {
      toast(payload.message);
      return;
    }
    if (payload.type === 'changed') {
      refresh();
    }
  });
}

async function init() {
  // 选中项目时提前探测运行类型
  bindEvents();
  syncTabs();
  try {
    await refresh();
    if (state.selectedId) ensureDetection(state.selectedId);
    $('app-version').textContent = state.appVersion ? `v${state.appVersion}` : '';
  } catch (error) {
    toast(`初始化失败：${error.message}`, 'error');
  }
}

init();
