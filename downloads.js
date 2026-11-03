// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

const ACTIVE_STATUSES = new Set([
  'starting',
  'fetchingTorrent',
  'adding',
  'awaitingTorrent',
  'awaitingMetadata',
  'downloading',
  'queued',
  'processing'
]);

const QB_STATE_LABELS = {
  en: {
    allocating: 'Allocating space',
    checkingDL: 'Checking files',
    checkingResumeData: 'Checking resume data',
    checkingUP: 'Verifying files',
    downloading: 'Downloading',
    error: 'Download error',
    forcedDL: 'Forced downloading',
    forcedMetaDL: 'Forcing metadata',
    forcedUP: 'Seeding',
    metaDL: 'Fetching metadata',
    missingFiles: 'Files missing',
    moving: 'Moving files',
    pausedDL: 'Download paused',
    pausedUP: 'Seeding paused',
    queuedDL: 'Queued for download',
    queuedUP: 'Queued for seeding',
    stalledDL: 'Waiting for peers',
    stalledUP: 'Waiting to seed',
    stoppedDL: 'Download stopped',
    stoppedUP: 'Seeding stopped',
    unknown: 'Unknown state',
    uploading: 'Seeding'
  },
  zh: {
    allocating: '分配空间',
    checkingDL: '校验下载文件',
    checkingResumeData: '校验续传数据',
    checkingUP: '校验完成文件',
    downloading: '下载中',
    error: '下载错误',
    forcedDL: '强制下载中',
    forcedMetaDL: '强制获取种子',
    forcedUP: '做种中',
    metaDL: '获取种子信息',
    missingFiles: '文件缺失',
    moving: '移动文件',
    pausedDL: '暂停下载',
    pausedUP: '暂停做种',
    queuedDL: '等待下载队列',
    queuedUP: '等待做种队列',
    stalledDL: '等待连接',
    stalledUP: '等待做种',
    stoppedDL: '停止下载',
    stoppedUP: '停止做种',
    unknown: '状态未知',
    uploading: '做种中'
  }
};

function qbStateLabel(state) {
  return QB_STATE_LABELS[currentLanguage]?.[state] || state || t('downloads.waiting');
}


const refs = {
  taskList: document.getElementById('taskList'),
  countActive: document.getElementById('countActive'),
  countCompleted: document.getElementById('countCompleted'),
  countError: document.getElementById('countError'),
  liveDot: document.getElementById('liveDot'),
  liveText: document.getElementById('liveText'),
  clearFinished: document.getElementById('clearFinished'),
  refreshButton: document.getElementById('refreshButton'),
  settingsButton: document.getElementById('settingsButton'),
  openLanraragi: document.getElementById('openLanraragi'),
  openQB: document.getElementById('openQB'),
  languageSelect: document.getElementById('languageSelect'),
  toast: document.getElementById('toast')
};

let tasks = [];
let settings = {};
let currentFilter = 'active';
let refreshInFlight = false;
let refreshTimer = null;
let refreshSequence = 0;
let toastTimer = null;
let currentLanguage = TSUKIHI_DEFAULT_LANGUAGE;

initialize();

async function initialize() {
  currentLanguage = await tsukihiGetLanguage();
  refs.languageSelect.value = currentLanguage;
  tsukihiApplyPageTranslations(currentLanguage);
  tsukihiBindLanguageSelect(refs.languageSelect, async (language) => {
    currentLanguage = language;
    tsukihiApplyPageTranslations(language);
    render();
  });
  tsukihiWatchLanguage((language) => {
    if (language === currentLanguage) return;
    currentLanguage = language;
    refs.languageSelect.value = language;
    tsukihiApplyPageTranslations(language);
    render();
  });

  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  });

  refs.clearFinished.addEventListener('click', clearFinished);
  refs.refreshButton.addEventListener('click', () => refreshTasks({ forcePoll: true, manual: true }));
  refs.settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
  refs.openLanraragi.addEventListener('click', openLanraragiJobs);
  refs.openQB.addEventListener('click', openQBWebUI);

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.type === 'updateFromBackground') {
      refreshTasks();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshTasks({ forcePoll: true });
  });

  refreshTasks({ forcePoll: true });
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshTasks();
  }, 2200);
}

function t(key, variables = {}) {
  return tsukihiTranslate(currentLanguage, key, variables);
}

async function refreshTasks(options = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refs.taskList.setAttribute('aria-busy', 'true');
  refs.refreshButton.disabled = true;

  try {
    refreshSequence += 1;
    const shouldPoll = options.forcePoll || refreshSequence % 2 === 0;
    const response = await sendMessage({
      type: shouldPoll ? 'refreshDownloadTasks' : 'getDownloadTasks'
    });
    if (!response?.ok) throw new Error(response?.error || t('downloads.cannotRead'));

    tasks = Array.isArray(response.tasks) ? response.tasks : [];
    settings = response.settings || {};
    render();
  } catch (error) {
    console.warn('Could not load download tasks:', error);
    if (tasks.length === 0) renderLoadError(error.message || String(error));
    if (options.manual) showToast(t('downloads.refreshFailed', { error: error.message || error }));
  } finally {
    refreshInFlight = false;
    refs.taskList.setAttribute('aria-busy', 'false');
    refs.refreshButton.disabled = false;
  }
}

function render() {
  const openDetails = new Set(
    Array.from(refs.taskList.querySelectorAll('details[open][data-task-id]'))
      .map((element) => element.dataset.taskId)
  );

  const activeCount = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const errorCount = tasks.filter((task) => task.status === 'error').length;

  refs.countActive.textContent = String(activeCount);
  refs.countCompleted.textContent = String(completedCount);
  refs.countError.textContent = String(errorCount);
  updateFilterCounts(activeCount, completedCount, errorCount);
  updateLiveStatus(activeCount);
  updateHeaderActions();
  refs.clearFinished.disabled = completedCount + errorCount === 0;

  const filtered = tasks.filter((task) => matchesFilter(task, currentFilter));
  refs.taskList.replaceChildren();

  if (filtered.length === 0) {
    refs.taskList.append(createEmptyState());
    return;
  }

  for (const task of filtered) {
    refs.taskList.append(createTaskCard(task, openDetails));
  }
}

function updateFilterCounts(activeCount, completedCount, errorCount) {
  const counts = {
    active: activeCount,
    all: tasks.length,
    completed: completedCount,
    error: errorCount
  };

  document.querySelectorAll('[data-count]').forEach((element) => {
    element.textContent = String(counts[element.dataset.count] || 0);
  });
}

function updateLiveStatus(activeCount) {
  const live = refs.liveText.closest('.hero-live');
  if (activeCount > 0) {
    live.dataset.tone = 'active';
    refs.liveText.textContent = t('downloads.syncingCount', { count: activeCount });
  } else {
    live.dataset.tone = 'idle';
    refs.liveText.textContent = t('downloads.allSynced');
  }
}

function updateHeaderActions() {
  refs.openLanraragi.disabled = !settings.server;
  refs.openQB.disabled = !settings.qbServer;
}

function setFilter(filter) {
  if (!['active', 'all', 'completed', 'error'].includes(filter)) return;
  currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.filter === filter));
  });
  render();
}

function matchesFilter(task, filter) {
  if (filter === 'active') return ACTIVE_STATUSES.has(task.status);
  if (filter === 'completed') return task.status === 'completed';
  if (filter === 'error') return task.status === 'error';
  return true;
}

function createTaskCard(task, openDetails) {
  const card = element('article', 'download-card');
  card.dataset.source = task.source;
  card.dataset.status = task.status;

  card.append(createTaskHeader(task));
  card.append(createProgressBlock(task));

  const signals = createSignals(task);
  if (signals.childElementCount > 0) card.append(signals);

  if (task.status === 'error' && task.error) {
    const error = element('div', 'task-error', task.error);
    card.append(error);
  }

  if (task.source === 'qb' && Array.isArray(task.qb?.files) && task.qb.files.length > 0) {
    const details = createFilesPanel(task);
    details.dataset.taskId = task.id;
    details.open = openDetails.has(task.id);
    card.append(details);
  }

  card.append(createTaskFooter(task));
  return card;
}

function createTaskHeader(task) {
  const header = element('header', 'task-header');
  const engine = element('span', 'task-engine', task.source === 'qb' ? 'qB' : 'LRR');
  engine.setAttribute('aria-hidden', 'true');

  const titleBlock = element('div', 'task-title-block');
  const title = element('h3', '', task.qb?.name || task.title || task.url || t('downloads.unnamedTask'));
  title.title = title.textContent;
  const subtitle = element('p', '', describeTask(task));
  subtitle.title = subtitle.textContent;
  titleBlock.append(title, subtitle);

  const status = getStatusInfo(task);
  const pill = element('span', 'status-pill', status.label);
  pill.dataset.tone = status.tone;

  header.append(engine, titleBlock, pill);
  return header;
}

function createProgressBlock(task) {
  const wrapper = element('div', 'task-progress');
  const head = element('div', 'task-progress-head');
  const label = element('span', '', getProgressLabel(task));
  const progress = getProgress(task);
  const percent = element('strong', '', progress.known ? `${Math.round(progress.value)}%` : '—');
  head.append(label, percent);

  const track = element('div', 'progress-track');
  const fill = element('div', 'progress-fill');
  if (progress.indeterminate) {
    track.classList.add('is-indeterminate');
  } else {
    fill.style.width = `${clamp(progress.value, 0, 100)}%`;
    if (task.status === 'completed') track.classList.add('is-complete');
    if (task.status === 'error') track.classList.add('is-error');
  }
  track.append(fill);
  wrapper.append(head, track, createStats(task));
  return wrapper;
}

function createStats(task) {
  const stats = element('div', 'task-stats');

  if (task.source === 'qb') {
    const qb = task.qb || {};
    if (qb.size > 0) {
      stats.append(
        stat(t('downloads.files'), `${formatBytes(qb.downloadedBytes || 0)} / ${formatBytes(qb.size)}`),
        stat(t('downloads.speed'), qb.speed > 0 ? formatSpeed(qb.speed) : t('common.waitingForConnection')),
        stat(t('downloads.remaining'), formatEta(qb.eta)),
        stat(t('downloads.status'), qbStateLabel(qb.state) || t('downloads.waiting'))
      );
    } else {
      stats.append(stat(t('downloads.torrentStatus'), qb.torrentAcquired ? t('downloads.acquired') : t('downloads.fetching')));
    }
  } else {
    const job = task.lrr?.jobId;
    if (job) stats.append(stat('LANraragi Job', `#${job}`));
    if (task.lrr?.state) stats.append(stat(t('downloads.queueStatus'), getLRRStateLabel(task.lrr.state)));
    if (task.lrr?.arcId) stats.append(stat(t('downloads.archiveId'), task.lrr.arcId));
  }

  return stats;
}

function createSignals(task) {
  const container = element('div', 'task-signals');
  const qb = task.qb || {};

  if (task.source === 'qb') {
    if (task.status === 'completed') {
      container.append(signal(qb.torrentAcquired ? t('downloads.torrentAcquired') : t('downloads.qbComplete'), 'success'));
    } else if (qb.torrentAcquired) {
      container.append(signal(t('downloads.torrentAcquired'), 'success'));
    } else if (['starting', 'fetchingTorrent', 'adding', 'awaitingTorrent', 'awaitingMetadata'].includes(task.status)) {
      container.append(signal(t('downloads.confirmingTorrent'), 'warning'));
    }

    if (qb.fileCount) container.append(signal(t('downloads.fileCount', { count: qb.fileCount }), 'running'));
    if (qb.state) container.append(signal(qbStateLabel(qb.state), task.status === 'error' ? 'danger' : 'running'));
  } else {
    container.append(signal(t('downloads.directLink'), 'running'));
    if (task.batch) container.append(signal(t('downloads.batchTask')));
  }

  return container;
}

function createFilesPanel(task) {
  const files = task.qb?.files || [];
  const details = element('details', 'files-panel');
  const summary = element('summary');
  summary.append(
    document.createTextNode(t('downloads.fileProgress', { count: files.length })),
    element('span', 'sr-only', task.qb?.hiddenFileCount ? t('downloads.hiddenFiles', { count: task.qb.hiddenFileCount }) : '')
  );

  const list = element('div', 'files-list');
  for (const file of files) {
    const row = element('div', 'file-row');
    const name = element('span', 'file-name', file.name || t('downloads.unnamedFile'));
    name.title = name.textContent;
    const size = element('span', 'file-size', `${formatBytes(file.size)} · ${Math.round(file.progress || 0)}%`);
    const progress = element('div', 'file-progress');
    const fill = element('span');
    fill.style.width = `${clamp(file.progress || 0, 0, 100)}%`;
    progress.append(fill);
    row.append(name, size, progress);
    list.append(row);
  }

  if (task.qb?.hiddenFileCount > 0) {
    list.append(element('div', 'file-note', t('downloads.hiddenFileNote', { count: task.qb.hiddenFileCount })));
  }

  details.append(summary, list);
  return details;
}

function createTaskFooter(task) {
  const footer = element('footer', 'task-footer');
  const time = element('span', 'task-time', t('downloads.updated', { time: formatRelativeTime(task.updatedAt || task.createdAt) }));
  const actions = element('div', 'task-actions');

  if (task.source === 'lrr' && task.status === 'completed' && task.lrr?.arcId && settings.server) {
    actions.append(actionButton(t('downloads.openArchive'), () => openUrl(`${settings.server}/reader?id=${encodeURIComponent(task.lrr.arcId)}`)));
  }

  if (task.source === 'qb' && settings.qbServer) {
    actions.append(actionButton(t('downloads.openQB'), () => openUrl(settings.qbServer)));
  }

  if (task.url) {
    actions.append(actionButton(t('downloads.openSource'), () => openUrl(task.url)));
  }

  footer.append(time, actions);
  return footer;
}

function actionButton(label, handler) {
  const button = element('button', 'button button-secondary', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function getProgress(task) {
  if (task.status === 'completed') {
    return { known: true, value: 100, indeterminate: false };
  }

  if (task.source === 'lrr') {
    return { known: false, value: 0, indeterminate: ACTIVE_STATUSES.has(task.status) };
  }

  const qb = task.qb || {};
  const known = Boolean(qb.torrentAcquired || task.progress > 0 || task.status === 'error');
  return {
    known,
    value: Number(task.progress ?? qb.progress ?? 0),
    indeterminate: !known && ACTIVE_STATUSES.has(task.status)
  };
}

function getStatusInfo(task) {
  if (task.status === 'completed') return { label: t('downloads.completedLabel'), tone: 'success' };
  if (task.status === 'error') return { label: t('downloads.failedLabel'), tone: 'danger' };
  if (task.source === 'qb' && !task.qb?.torrentAcquired) return { label: t('downloads.fetchingLabel'), tone: 'warning' };
  if (task.source === 'qb') return { label: t('downloads.downloadingLabel'), tone: 'running' };
  if (task.status === 'queued') return { label: t('downloads.queuedLabel'), tone: 'warning' };
  return { label: t('downloads.processingLabel'), tone: 'running' };
}

function describeTask(task) {
  if (task.source === 'qb') {
    const qb = task.qb || {};
    if (task.status === 'completed') return qb.contentPath || qb.savePath || t('downloads.torrentComplete');
    if (!qb.torrentAcquired) return t('downloads.waitingTorrent');
    return `${qbStateLabel(qb.state)}${qb.savePath ? ` · ${qb.savePath}` : ''}`;
  }
  return task.url || t('popup.lrrTask');
}

function getProgressLabel(task) {
  if (task.status === 'completed' || task.status === 'error') return getStatusInfo(task).label;
  if (task.source === 'qb' && !task.qb?.torrentAcquired) return t('downloads.fetchingLabel');
  if (task.source === 'qb' && task.qb?.state) return qbStateLabel(task.qb.state);
  if (task.status === 'queued') return t('downloads.queuedLabel');
  return t('downloads.processingLabel');
}

function getLRRStateLabel(state) {
  if (state === 'queued') return t('downloads.queuedLabel');
  if (state === 'processing') return t('downloads.processingLabel');
  return state;
}

function stat(label, value) {
  const item = element('span', 'task-stat');
  item.append(element('strong', '', label), document.createTextNode(value));
  return item;
}

function signal(label, tone) {
  const item = element('span', 'signal', label);
  if (tone) item.dataset.tone = tone;
  return item;
}

function createEmptyState() {
  const empty = element('div', 'empty-card');
  const visual = element('div', 'empty-visual', currentFilter === 'error' ? '✓' : '↓');
  const copy = element('div');
  const messages = {
    active: [t('downloads.emptyActiveTitle'), t('downloads.emptyActiveHint')],
    all: [t('downloads.emptyAllTitle'), t('downloads.emptyAllHint')],
    completed: [t('downloads.emptyCompletedTitle'), t('downloads.emptyCompletedHint')],
    error: [t('downloads.emptyErrorTitle'), t('downloads.emptyErrorHint')]
  };
  const [title, description] = messages[currentFilter] || messages.all;
  copy.append(element('strong', '', title), element('p', '', description));
  empty.append(visual, copy);
  return empty;
}

function renderLoadError(message) {
  refs.taskList.replaceChildren();
  const empty = element('div', 'empty-card');
  empty.append(
    element('div', 'empty-visual', '!'),
    (() => {
      const copy = element('div');
      copy.append(
        element('strong', '', t('downloads.syncErrorTitle')),
        element('p', '', message)
      );
      return copy;
    })()
  );
  refs.taskList.append(empty);
}

async function clearFinished() {
  try {
    const response = await sendMessage({ type: 'clearFinishedTasks' });
    if (!response?.ok) throw new Error(response?.error || t('common.unknown'));
    await refreshTasks({ forcePoll: true });
    showToast(response.removed ? t('downloads.cleared', { count: response.removed }) : t('downloads.nothingToClear'));
  } catch (error) {
    showToast(t('downloads.clearFailed', { error: error.message || error }));
  }
}

function openLanraragiJobs() {
  if (!settings.server) {
    showToast(t('downloads.lrrNotConfigured'));
    chrome.runtime.openOptionsPage();
    return;
  }
  openUrl(`${settings.server}/minion/jobs`);
}

function openQBWebUI() {
  if (!settings.qbServer) {
    showToast(t('downloads.qbNotConfigured'));
    chrome.runtime.openOptionsPage();
    return;
  }
  openUrl(settings.qbServer);
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond || 0);
  return value > 0 ? `${formatBytes(value)}/s` : t('common.waitingForConnection');
}

function formatEta(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0 || value >= 8640000) return t('downloads.etaUnknown');
  if (value < 60) return t('downloads.etaSeconds', { count: Math.ceil(value) });
  if (value < 3600) return t('downloads.etaMinutes', { count: Math.ceil(value / 60) });
  if (value < 86400) return t('downloads.etaHours', { hours: (value / 3600).toFixed(1) });
  return t('downloads.etaDays', { days: (value / 86400).toFixed(1) });
}

function formatRelativeTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return t('downloads.justNow');
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 30) return t('downloads.justNow');
  if (seconds < 3600) return t('downloads.minutesAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('downloads.hoursAgo', { count: Math.floor(seconds / 3600) });
  return new Date(value).toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      settled = true;
      reject(new Error(t('downloads.backgroundTimeout', { seconds: Math.round(timeoutMs / 1000) })));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response) reject(new Error(t('downloads.backgroundNoResponse')));
        else resolve(response);
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => refs.toast.classList.remove('is-visible'), 2800);
}
