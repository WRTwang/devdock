'use strict';

const api = window.devdock;
const ServiceForm = window.DevDockServiceForm;
const LogFilter = window.DevDockLogFilter;
const DescribeDetection = window.DevDockDetectSummary;
const $ = (id) => document.getElementById(id);

const state = {
  profiles: [],
  activeId: null,
  setupAt: {},
  running: {},
  selectedId: null,
  tab: 'config',
  logFilter: '',
  editingId: null,
  editorServices: [],
  busy: {},
  detected: {},
  envcheck: {},
  envBusy: {},
  dbReady: new Set(),
  pendingStart: null,
  pendingPlan: null,
  pendingDbProfile: null,
  pendingDelete: null,
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
  state.dbReady = new Set(Array.isArray(data.dbReady) ? data.dbReady : []);
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
  renderLogServiceFilter(profile);
  renderEnvPanel(profile);
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
  $('cfg-launcher').textContent = profile.linkLauncher ? 'devdock.cmd' : '未生成';

  renderServiceCard(profile);

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
  if (!node) return;
  if (command) {
    node.textContent = command;
    node.classList.remove('empty');
  } else {
    node.textContent = '未配置';
    node.classList.add('empty');
  }
}

const ROLE_LABELS = {
  frontend: '前端',
  backend: '后端',
  database: '数据库',
  worker: '后台任务',
  app: '应用',
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

function renderServiceCard(profile) {
  const services = Array.isArray(profile.services) ? profile.services : [];
  const summary = LogFilter.summarizeServices(services, state.running[profile.id]);
  const box = $('cfg-services');
  const nameById = new Map(services.map((service) => [service.id, service.name]));

  if (summary.length === 0) {
    box.innerHTML = '<span class="mini-tag">未配置服务</span>';
    return;
  }

  box.innerHTML = summary
    .map(
      (service) => `
      <div class="service-item">
        <div class="service-item-head">
          <span class="status-dot ${service.running ? 'running' : ''}"></span>
          <span class="service-item-name">${escapeHtml(service.name)}</span>
          <span class="mini-tag">${roleLabel(service.role)}</span>
          ${service.port ? `<span class="mini-tag">:${service.port}</span>` : ''}
        </div>
        <code class="${service.startCommand ? '' : 'blank'}">${escapeHtml(service.startCommand || '无启动命令')}</code>
        ${
          service.dependsOn && service.dependsOn.length
            ? `<div class="service-item-meta">依赖 ${service.dependsOn
                .map((id) => escapeHtml(nameById.get(id) || id))
                .join('、')}</div>`
            : ''
        }
      </div>`,
    )
    .join('');
}

function renderLogServiceFilter(profile) {
  const select = $('log-service-filter');
  const services = Array.isArray(profile.services) ? profile.services : [];
  const options = ['<option value="">全部服务</option>']
    .concat(services.map((service) => `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name)}</option>`))
    .join('');
  select.innerHTML = options;

  const stillExists = services.some((service) => service.id === state.logFilter);
  if (!stillExists) state.logFilter = '';
  select.value = state.logFilter;
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

/* ---------------- 环境体检 ---------------- */

const ENV_STATUS_TEXT = { ok: '已就绪', missing: '缺失', error: '异常' };

async function ensureEnvcheck(id, { force = false } = {}) {
  const profile = profileById(id);
  if (!profile) return null;
  if (!force && state.envcheck[id]) return state.envcheck[id];
  if (state.envBusy[id]) return state.envcheck[id] || null;

  state.envBusy[id] = true;
  if (state.selectedId === id) renderEnvPanel(profile);

  try {
    const result = await api.inspectEnv(id);
    state.envcheck[id] = result;
    if (result.dbReady) state.dbReady.add(id);
    else state.dbReady.delete(id);
    return result;
  } catch (error) {
    const failed = {
      error: error.message,
      items: [],
      toolchain: [],
      database: null,
      plan: { steps: [], consent: [], hasWork: false },
      summary: { ok: 0, missing: 0, error: 1 },
    };
    state.envcheck[id] = failed;
    toast(`环境体检失败：${error.message}`, 'error');
    return failed;
  } finally {
    delete state.envBusy[id];
    if (state.selectedId === id) renderDetail();
  }
}

function statusDot(status) {
  return `<span class="status-dot ${status === 'ok' ? 'running' : status}"></span>`;
}

function renderEnvPanel(profile) {
  const data = state.envcheck[profile.id];
  const busy = Boolean(state.envBusy[profile.id]);
  const summary = $('env-summary');
  const list = $('env-list');
  const installBtn = $('btn-env-install');
  installBtn.disabled = true;

  if (!data) {
    summary.className = 'env-summary';
    summary.textContent = busy ? '正在体检…' : '尚未体检';
    list.innerHTML = '';
    renderDbCard(null, profile);
    renderToolList([]);
    return;
  }

  if (data.error) {
    summary.className = 'env-summary';
    summary.innerHTML = `<span class="env-status error">体检失败：${escapeHtml(data.error)}</span>`;
    list.innerHTML = '';
    renderDbCard(null, profile);
    renderToolList([]);
    return;
  }

  const counts = data.summary || { ok: 0, missing: 0, error: 0 };
  summary.className = 'env-summary';
  summary.innerHTML =
    `已就绪 <b class="env-status ok">${counts.ok || 0}</b> · ` +
    `缺失 <b class="env-status missing">${counts.missing || 0}</b> · ` +
    `异常 <b class="env-status error">${counts.error || 0}</b>` +
    (data.runtime ? ` · ${escapeHtml(data.runtime)}` : '');

  list.innerHTML = data.items
    .map((item) => {
      const detailClass = `env-status ${item.status}`;
      const consent = Array.isArray(item.consent) ? item.consent : [];
      return `
        <div class="env-item ${item.status}">
          ${statusDot(item.status)}
          <div class="env-item-body">
            <div class="env-item-head">
              <span class="env-item-name">${escapeHtml(item.label)}</span>
              <span class="${detailClass}">${ENV_STATUS_TEXT[item.status] || item.status}</span>
              ${item.evidence ? `<span class="mini-tag">${escapeHtml(item.evidence)}</span>` : ''}
              <div class="spacer" style="flex:1"></div>
              ${
                item.status !== 'ok' && item.install && item.install.length
                  ? `<button class="link-btn" data-install="${escapeHtml(item.id)}">安装此项</button>`
                  : ''
              }
            </div>
            <div class="env-item-detail ${detailClass}">${escapeHtml(item.detail)}</div>
            ${item.install && item.install.length ? `<code class="env-command">${escapeHtml(item.install[0])}</code>` : ''}
            ${
              consent.length
                ? `<div class="env-consent">需要先获取工具：${consent
                    .map((plan) => escapeHtml(plan.title))
                    .join('；')}</div>`
                : ''
            }
          </div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-install]').forEach((button) => {
    button.addEventListener('click', () => openPlanDialog(profile, [button.dataset.install]));
  });

  renderDbCard(data, profile);
  renderToolList(data.toolchain);

  const plan = data.plan || { steps: [], consent: [], hasWork: false };
  installBtn.disabled = busy || !plan.hasWork;
}

function renderToolList(toolchain) {
  const box = $('tool-list');
  if (!toolchain || toolchain.length === 0) {
    box.innerHTML = '<span class="mini-tag">未检测到运行时工具</span>';
    return;
  }
  box.innerHTML = toolchain
    .map((tool) => {
      const status = tool.ok ? 'ok' : 'missing';
      const text = tool.found ? `${tool.label} ${tool.version || ''}`.trim() : `${tool.label} 未安装`;
      const title = tool.found && !tool.ok ? `需要 ≥ ${tool.minimum}` : '';
      return `<span class="tool-chip ${status}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
    })
    .join('');
}

function renderDbCard(data, profile) {
  const card = $('db-card');
  const database = data && data.database;
  if (!database) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const ready = state.dbReady.has(profile.id);
  const mode = database.container
    ? 'Docker 容器'
    : database.local
      ? `本机服务 ${database.local.name}${database.local.running ? '（运行中）' : '（未启动）'}`
      : '未检测到本机服务';
  const hint = database.container
    ? ready
      ? '连接串已注入；容器由 docker compose 启动'
      : '容器由 docker compose 启动；需要连接串时在右侧填写'
    : ready
      ? '连接串已注入，启动项目时会自动带上'
      : '还没有输入密码，启动前会先询问';

  $('db-info').innerHTML = `
    <div><b class="env-status ok">${escapeHtml(database.label)}</b>
      <span class="mini-tag">端口 ${database.port}</span>
      <span class="mini-tag">${escapeHtml(mode)}</span>
    </div>
    <div class="env-item-detail ${ready ? 'env-status ok' : 'env-status missing'}">
      ${hint}
    </div>`;
  $('btn-db-prepare').textContent = ready ? '重新输入密码' : '输入密码并启动';
}

function openPlanDialog(profile, itemIds) {
  const data = state.envcheck[profile.id];
  if (!data || !data.plan) return;
  const plan = data.plan;
  const wanted = itemIds ? new Set(itemIds) : null;
  const pick = (step) => (wanted ? wanted.has(step.itemId) : true);
  const steps = plan.steps.filter(pick);
  const consents = plan.consent.filter(pick);
  const all = [...consents, ...steps];

  if (all.length === 0) {
    toast('没有需要安装的环境项', 'error');
    return;
  }

  state.pendingPlan = { projectId: profile.id, itemIds, allowToolDownload: consents.length > 0 };
  $('env-plan-note').textContent = consents.length
    ? '带「需下载」的步骤会联网并修改本机工具，只有点确认后才会执行。'
    : '下面这些命令会在项目目录里执行，输出会出现在运行日志里。';
  $('env-plan-list').innerHTML = all
    .map(
      (step) => `
      <li>
        <div>${escapeHtml(step.title)}${step.needsConsent ? '<span class="mini-tag warn">需下载</span>' : ''}</div>
        <code>${escapeHtml(step.command)}</code>
      </li>`,
    )
    .join('');
  $('btn-plan-confirm').textContent = consents.length ? '同意并安装' : '开始安装';
  $('env-plan-dialog').showModal();
}

async function confirmPlan() {
  const pending = state.pendingPlan;
  if (!pending) return;
  const { projectId, itemIds, allowToolDownload } = pending;
  state.pendingPlan = null;
  $('env-plan-dialog').close();

  state.envBusy[projectId] = 'install';
  renderDetail();
  try {
    await api.installEnv(projectId, { itemIds, allowToolDownload });
    state.tab = 'logs';
    syncTabs();
    toast('开始安装环境，日志已切换到「运行日志」');
  } catch (error) {
    delete state.envBusy[projectId];
    renderDetail();
    toast(error.message, 'error');
  }
}

function openDbDialog(profile, database) {
  state.pendingDbProfile = profile.id;
  const mode = database.container
    ? 'Docker 容器（docker compose 负责启动）'
    : database.local
      ? `本机服务 ${database.local.name}${database.local.running ? '（运行中）' : '（未启动）'}`
      : '未检测到本机服务，请先安装数据库';
  $('db-hint').textContent = `${database.label} · 端口 ${database.port} · ${mode}`;
  $('db-user').value = database.user || '';
  $('db-name').value = database.database || '';
  $('db-password').value = '';
  $('db-sync-env').checked = true;
  $('db-error').hidden = true;
  $('db-dialog').showModal();
  setTimeout(() => $('db-password').focus(), 30);
}

async function submitDbDialog(event) {
  event.preventDefault();
  const profile = profileById(state.pendingDbProfile);
  if (!profile) return;
  const button = $('btn-db-confirm');
  button.disabled = true;

  try {
    const result = await api.prepareDb(profile.id, {
      user: $('db-user').value,
      database: $('db-name').value,
      password: $('db-password').value,
      syncDotEnv: $('db-sync-env').checked,
    });
    state.dbReady.add(profile.id);
    $('db-dialog').close();
    state.pendingDbProfile = null;

    const failed = result.started && result.started.ok === false;
    toast(failed ? `${result.label} 连接串已保存；${result.started.message}` : `${result.label} 已就绪`, failed ? 'error' : 'success');
    state.envcheck[profile.id] = null;
    ensureEnvcheck(profile.id, { force: true });

    const pending = state.pendingStart;
    state.pendingStart = null;
    if (pending === profile.id) start(profile);
  } catch (error) {
    $('db-error').textContent = error.message;
    $('db-error').hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function openDeleteDialog(profile) {
  const residues = await api.envResidue(profile.dir).catch(() => []);
  state.pendingDelete = profile;
  const has = residues.length > 0;
  $('delete-hint').textContent = `将从 DevDock 删除「${profile.name}」的档案，项目源码不会被删除。`;
  $('delete-env').checked = has;
  $('delete-env').disabled = !has;
  $('delete-env-label').textContent = has
    ? '同时删除项目内的环境与残留（不可恢复）'
    : '项目里没有发现环境残留';
  $('residue-list').hidden = !has;
  $('residue-list').innerHTML = residues
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.name)}</span><span class="mini-tag">${item.kind === 'env' ? '环境' : '残留'}</span></li>`,
    )
    .join('');
  $('delete-dialog').showModal();
}

async function confirmDelete() {
  const profile = state.pendingDelete;
  if (!profile) return;
  const removeEnv = $('delete-env').checked;
  state.pendingDelete = null;
  $('delete-dialog').close();

  try {
    const result = await api.remove(profile.id, { removeEnv });
    state.logs.delete(profile.id);
    delete state.envcheck[profile.id];
    delete state.detected[profile.id];
    state.dbReady.delete(profile.id);
    if (state.selectedId === profile.id) state.selectedId = null;
    await refresh();
    const count = result && Array.isArray(result.removedEnvs) ? result.removedEnvs.length : 0;
    toast(removeEnv ? `档案已删除，清理了 ${count} 项环境残留` : '档案已删除', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
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
  const serviceId = payload.serviceId || 'main';
  const store = logStore(projectId);
  if (logFile) store.logFile = logFile;

  store.chunks.push({ serviceId, stream, text: chunk });
  store.bytes += chunk.length;
  while (store.bytes > 1_500_000 && store.chunks.length > 1) {
    const removed = store.chunks.shift();
    store.bytes -= removed.text.length;
  }

  if (state.selectedId === projectId && state.tab === 'logs') {
    if (!state.logFilter || state.logFilter === serviceId) {
      appendLogDom(stream, chunk);
    }
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
  const visible = store ? LogFilter.filterChunks(store.chunks, state.logFilter) : [];

  if (visible.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'placeholder';
    placeholder.textContent = state.logFilter
      ? '该服务还没有输出。'
      : '等待输出… 点击「启动」或「搭环境」后日志会显示在这里。';
    output.appendChild(placeholder);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chunk of visible) {
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
  $('panel-env').hidden = state.tab !== 'env';
  $('panel-logs').hidden = state.tab !== 'logs';
  $('log-tools').hidden = state.tab !== 'logs';
  if (state.tab === 'logs') renderLogs();
  if (state.tab === 'env' && state.selectedId) ensureEnvcheck(state.selectedId);
}

/* ---------------- 动作 ---------------- */

async function activate(profile) {
  await api.activate(profile.id);
  state.activeId = profile.id;
  renderAll();
  toast(`已切换到 ${profile.name} 的环境`, 'success');
}

async function start(profile) {
  const inspection = state.envcheck[profile.id] || (await ensureEnvcheck(profile.id));
  if (inspection && inspection.database && !inspection.database.container && !state.dbReady.has(profile.id)) {
    state.pendingStart = profile.id;
    openDbDialog(profile, inspection.database);
    return;
  }

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
  await openDeleteDialog(profile);
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
  $('f-auto-setup').checked = profile ? profile.autoSetup : true;
  $('f-sync-env').checked = profile ? profile.syncDotEnv : false;
  $('f-link-launcher').checked = profile ? profile.linkLauncher !== false : true;
  $('service-error').hidden = true;

  const rows = profile ? ServiceForm.buildRows(profile) : [];
  if (rows.length === 0) {
    rows.push({ id: 'main', name: '', role: 'app', cwd: '.', setupCommand: '', startCommand: '', port: null, dependsOn: [], envVars: [] });
  }
  state.editorServices = rows;
  renderServiceEditor();

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
  state.editorServices = [];
}

function renderServiceEditor() {
  const box = $('service-editor');
  box.innerHTML = '';

  state.editorServices.forEach((service, index) => {
    const row = document.createElement('div');
    row.className = 'service-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="service-row-head">
        <input class="svc-name" data-field="name" type="text" placeholder="服务名，如 web / api / db" autocomplete="off" />
        <select class="svc-role" data-field="role">
          <option value="frontend">前端</option>
          <option value="backend">后端</option>
          <option value="database">数据库</option>
          <option value="worker">后台任务</option>
          <option value="app">应用</option>
        </select>
        <input class="svc-port" data-field="port" type="text" placeholder="端口" inputmode="numeric" autocomplete="off" />
        <button type="button" class="btn btn-ghost btn-icon svc-remove" title="删除服务">×</button>
      </div>
      <div class="service-row-grid">
        <input class="svc-cwd" data-field="cwd" type="text" placeholder="目录 ." autocomplete="off" spellcheck="false" />
        <input class="svc-setup" data-field="setupCommand" type="text" placeholder="安装命令" autocomplete="off" spellcheck="false" />
        <input class="svc-start" data-field="startCommand" type="text" placeholder="启动命令" autocomplete="off" spellcheck="false" />
      </div>
      <div class="service-deps">
        <span>依赖</span>
        <div class="deps-chips"></div>
      </div>`;

    row.querySelector('.svc-name').value = service.name;
    row.querySelector('.svc-role').value = service.role;
    row.querySelector('.svc-port').value = service.port ?? '';
    row.querySelector('.svc-cwd').value = service.cwd;
    row.querySelector('.svc-setup').value = service.setupCommand;
    row.querySelector('.svc-start').value = service.startCommand;

    row.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const field = input.dataset.field;
        service[field] = input.value;
        if (field === 'name') refreshDependencyChips();
      });
    });

    row.querySelector('.svc-remove').addEventListener('click', () => removeService(index));
    renderDependencyChips(row.querySelector('.deps-chips'), service, index);
    box.appendChild(row);
  });
}

function renderDependencyChips(container, service, index) {
  container.innerHTML = '';
  const others = state.editorServices.filter((_, position) => position !== index);
  if (others.length === 0) {
    container.innerHTML = '<span class="detect-hint">无其他服务</span>';
    return;
  }

  for (const other of others) {
    const label = document.createElement('label');
    label.className = 'dep-chip';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = service.dependsOn.includes(other.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!service.dependsOn.includes(other.id)) service.dependsOn.push(other.id);
      } else {
        service.dependsOn = service.dependsOn.filter((id) => id !== other.id);
      }
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(other.name || other.id));
    container.appendChild(label);
  }
}

function refreshDependencyChips() {
  document.querySelectorAll('.service-row').forEach((row, index) => {
    const chips = row.querySelector('.deps-chips');
    if (chips) renderDependencyChips(chips, state.editorServices[index], index);
  });
}

function addService() {
  const used = new Set(state.editorServices.map((service) => service.id));
  let suffix = state.editorServices.length + 1;
  let id = `svc-${suffix}`;
  while (used.has(id)) {
    suffix += 1;
    id = `svc-${suffix}`;
  }
  state.editorServices.push({
    id,
    name: '',
    role: 'app',
    cwd: '.',
    setupCommand: '',
    startCommand: '',
    port: null,
    dependsOn: [],
    envVars: [],
  });
  renderServiceEditor();
}

function removeService(index) {
  if (state.editorServices.length <= 1) {
    toast('至少保留一个服务', 'error');
    return;
  }
  const [removed] = state.editorServices.splice(index, 1);
  for (const service of state.editorServices) {
    service.dependsOn = service.dependsOn.filter((id) => id !== removed.id);
  }
  renderServiceEditor();
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
    if (Array.isArray(result.services) && result.services.length > 0) {
      state.editorServices = result.services;
      renderServiceEditor();
    } else {
      const first = state.editorServices[0];
      if (first) {
        if (result.setupCommand) first.setupCommand = result.setupCommand;
        if (result.startCommand) first.startCommand = result.startCommand;
        if (!first.name.trim() && result.runtime) first.name = result.runtime;
        renderServiceEditor();
      }
    }
    hint.textContent = DescribeDetection.describeDetection(result);
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
  const errors = ServiceForm.validateRows(state.editorServices);
  if (errors.length > 0) {
    $('service-error').textContent = errors.join('；');
    $('service-error').hidden = false;
    return;
  }
  $('service-error').hidden = true;

  const services = ServiceForm.collectServices(state.editorServices);
  const primary = services.find((service) => service.role !== 'database') || services[0];
  const existing = state.editingId ? profileById(state.editingId) : null;

  const payload = {
    id: state.editingId || undefined,
    name: $('f-name').value.trim(),
    dir,
    shell: $('f-shell').value,
    setupCommand: primary ? primary.setupCommand : '',
    startCommand: primary ? primary.startCommand : '',
    stopCommand: existing ? existing.stopCommand : '',
    envVars: collectEnvVars(),
    services,
    autoSetup: $('f-auto-setup').checked,
    syncDotEnv: $('f-sync-env').checked,
    linkLauncher: $('f-link-launcher').checked,
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
      const suffix = saved.launcher ? '，已生成 devdock.cmd 启动器' : '';
      toast(`已创建并切换到 ${saved.name} 的环境${suffix}`, 'success');
    } else {
      const suffix = saved.launcher ? '，已更新 devdock.cmd' : '';
      toast(`配置已保存${suffix}`, 'success');
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

  $('btn-env-refresh').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) ensureEnvcheck(profile.id, { force: true });
  });
  $('btn-env-install').addEventListener('click', () => {
    const profile = selectedProfile();
    if (profile) openPlanDialog(profile, null);
  });
  $('btn-db-prepare').addEventListener('click', () => {
    const profile = selectedProfile();
    const data = profile ? state.envcheck[profile.id] : null;
    if (profile && data && data.database) openDbDialog(profile, data.database);
  });

  $('env-plan-close').addEventListener('click', () => $('env-plan-dialog').close());
  $('btn-plan-cancel').addEventListener('click', () => $('env-plan-dialog').close());
  $('env-plan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    confirmPlan();
  });

  $('db-close').addEventListener('click', () => {
    state.pendingDbProfile = null;
    state.pendingStart = null;
    $('db-dialog').close();
  });
  $('btn-db-cancel').addEventListener('click', () => {
    state.pendingDbProfile = null;
    state.pendingStart = null;
    $('db-dialog').close();
  });
  $('db-form').addEventListener('submit', submitDbDialog);

  $('delete-close').addEventListener('click', () => {
    state.pendingDelete = null;
    $('delete-dialog').close();
  });
  $('btn-delete-cancel').addEventListener('click', () => {
    state.pendingDelete = null;
    $('delete-dialog').close();
  });
  $('delete-form').addEventListener('submit', (event) => {
    event.preventDefault();
    confirmDelete();
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

  $('log-service-filter').addEventListener('change', (event) => {
    state.logFilter = event.target.value;
    if (state.tab === 'logs') renderLogs();
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
  $('btn-add-service').addEventListener('click', addService);

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
    if (payload.type === 'open-project') {
      refresh()
        .then(() => {
          state.selectedId = payload.projectId;
          state.tab = 'logs';
          renderAll();
          syncTabs();
          const profile = profileById(payload.projectId);
          if (profile && payload.autoStart) start(profile);
        })
        .catch((error) => toast(error.message, 'error'));
      return;
    }
    if (payload.type === 'active') {
      state.activeId = payload.activeId;
      renderAll();
      return;
    }
    if (payload.type === 'running') {
      const id = payload.projectId;
      const serviceId = payload.serviceId || 'main';
      const bucket = state.running[id] || { running: false, services: [] };
      const services = new Set(bucket.services || []);

      if (payload.exitCode === undefined) services.add(serviceId);
      else services.delete(serviceId);

      if (services.size > 0) {
        state.running[id] = { running: true, services: [...services] };
      } else {
        delete state.running[id];
      }

      if (payload.exitCode !== undefined && (payload.kind === 'start' || payload.kind === 'setup')) {
        delete state.busy[id];
      }
      if (payload.kind === 'start' && payload.exitCode === undefined) delete state.busy[id];

      renderAll();
      return;
    }
    if (payload.type === 'setup-done') {
      delete state.busy[payload.projectId];
      delete state.envBusy[payload.projectId];
      state.setupAt[payload.projectId] = Date.now();
      renderAll();
      toast('环境搭建完成', 'success');
      ensureEnvcheck(payload.projectId, { force: true });
      return;
    }
    if (payload.type === 'db-ready') {
      state.dbReady.add(payload.projectId);
      renderDetail();
      return;
    }
    if (payload.type === 'error') {
      delete state.busy[payload.projectId];
      delete state.envBusy[payload.projectId];
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
    for (const profile of state.profiles) ensureDetection(profile.id);
    $('app-version').textContent = state.appVersion ? `v${state.appVersion}` : '';
  } catch (error) {
    toast(`初始化失败：${error.message}`, 'error');
  }
}

init();
