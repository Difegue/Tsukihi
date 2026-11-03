// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

if (typeof importScripts === 'function') importScripts('i18n.js');

const TASKS_STORAGE_KEY = 'tsukihiDownloadTasks';
const TASK_LIMIT = 100;
const QB_TORRENT_TIMEOUT_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;
const POLL_INTERVAL_MS = 4000;
const POLL_ALARM_NAME = 'tsukihi-download-poll';

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

const QB_ERROR_STATES = new Set(['error', 'missingFiles']);

const QB_STATE_LABELS = {
  en: {
    allocating: 'Allocating space',
    checkingDL: 'Checking downloaded files',
    checkingResumeData: 'Checking resume data',
    checkingUP: 'Download complete, verifying',
    downloading: 'Downloading',
    error: 'qBittorrent reported an error',
    forcedDL: 'Forced downloading',
    forcedMetaDL: 'Forced metadata download',
    forcedUP: 'Seeding',
    metaDL: 'Fetching torrent metadata',
    missingFiles: 'Files missing',
    moving: 'Moving files',
    pausedDL: 'Download paused',
    pausedUP: 'Seeding paused',
    queuedDL: 'Queued for download',
    queuedUP: 'Queued for seeding',
    stalledDL: 'Waiting for peers',
    stalledUP: 'Download complete, waiting to seed',
    stoppedDL: 'Download stopped',
    stoppedUP: 'Seeding stopped',
    unknown: 'Unknown qBittorrent state',
    uploading: 'Download complete, seeding'
  },
  zh: {
    allocating: '正在分配空间',
    checkingDL: '正在校验下载文件',
    checkingResumeData: '正在校验续传数据',
    checkingUP: '下载完成，正在校验',
    downloading: '下载中',
    error: 'qBittorrent 报告错误',
    forcedDL: '强制下载中',
    forcedMetaDL: '强制获取种子信息',
    forcedUP: '下载完成，正在做种',
    metaDL: '正在获取种子信息',
    missingFiles: '文件缺失',
    moving: '正在移动文件',
    pausedDL: '下载已暂停',
    pausedUP: '下载完成，已暂停做种',
    queuedDL: '等待下载队列',
    queuedUP: '等待做种队列',
    stalledDL: '等待可用连接',
    stalledUP: '下载完成，等待做种',
    stoppedDL: '下载已停止',
    stoppedUP: '下载完成，已停止做种',
    unknown: 'qBittorrent 状态未知',
    uploading: '下载完成，正在做种'
  }
};

function qbStateLabel(state) {
  return QB_STATE_LABELS[i18nLanguage]?.[state] || state || tr('downloads.waiting');
}

let tabHashmap = new Map();
const tabChecks = new Set();
let taskCache = null;
let taskMutationQueue = Promise.resolve();
let refreshPromise = null;
const qbSessions = new Set();
const qbAuthModes = new Map();
const runningQBTasks = new Set();
let i18nLanguage = TSUKIHI_DEFAULT_LANGUAGE;

function tr(key, variables = {}) {
  return tsukihiTranslate(i18nLanguage, key, variables);
}

// Keep the worker warm while a popup or download page is actively being used.
const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 25 * 1000);
const pollTimer = setInterval(() => {
  refreshActiveTasks().catch((error) => console.warn('Tsukihi poll failed:', error));
}, POLL_INTERVAL_MS);

/**
 * Extension lifecycle and browser integration.
 */

chrome.runtime.onInstalled.addListener((details) => {
  ensurePollAlarm();
  setupContextMenus();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm();
  refreshActiveTasks().catch((error) => console.warn('Tsukihi startup poll failed:', error));
});

ensurePollAlarm();

tsukihiGetLanguage().then((language) => {
  i18nLanguage = language;
  setupContextMenus();
}).catch((error) => console.warn('Could not load Tsukihi language:', error));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    refreshActiveTasks().catch((error) => console.warn('Tsukihi alarm poll failed:', error));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.tsukihiLanguage) return;
  i18nLanguage = tsukihiNormalizeLanguage(changes.tsukihiLanguage.newValue);
  setupContextMenus();
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'open-download-center') {
      openDownloadCenter();
      return;
    }

    const tab = await getActiveTab();
    if (!tab?.url) {
      showNotification(tr('notifications.cannotStart'), tr('notifications.noDownloadUrl'));
      return;
    }

    if (command === 'download-current-tab-qb') {
      const result = await beginDownload(tab, 'qb', { notify: true });
      if (!result.ok) showNotification(tr('notifications.qbNotStarted'), result.error);
      return;
    }

    if (command === 'download-current-tab') {
      const result = await beginDownload(tab, 'lrr', { notify: true });
      if (!result.ok) showNotification(tr('notifications.downloadNotStarted'), result.error);
    }
  } catch (error) {
    showNotification('Tsukihi', error.message || String(error));
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab?.id) return;

    if (info.menuItemId === 'tsukihi-download-link') {
      const linkTab = {
        id: tab.id,
        title: info.linkUrl,
        url: info.linkUrl,
        active: false
      };
      const result = await beginDownload(linkTab, 'lrr', { notify: true, associateTab: false });
      if (!result.ok) showNotification(tr('notifications.linkNotStarted'), result.error);
      return;
    }

    if (info.menuItemId === 'tsukihi-download-page') {
      const result = await beginDownload(tab, 'lrr', { notify: true });
      if (!result.ok) showNotification(tr('notifications.downloadNotStarted'), result.error);
      return;
    }

    if (info.menuItemId === 'tsukihi-download-qb-link') {
      const linkTab = {
        id: tab.id,
        title: info.linkUrl,
        url: info.linkUrl,
        active: false
      };
      const result = await beginDownload(linkTab, 'qb', { notify: true, associateTab: false });
      if (!result.ok) showNotification(tr('notifications.qbNotStarted'), result.error);
      return;
    }

    if (info.menuItemId === 'tsukihi-download-qb-page') {
      const result = await beginDownload(tab, 'qb', { notify: true });
      if (!result.ok) showNotification(tr('notifications.qbNotStarted'), result.error);
    }
  } catch (error) {
    showNotification('Tsukihi', error.message || String(error));
  }
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tsukihi-download-page',
      title: tr('notifications.contextLRRPage'),
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: 'tsukihi-download-link',
      title: tr('notifications.contextLRRLink'),
      contexts: ['link']
    });

    chrome.contextMenus.create({
      id: 'tsukihi-download-qb-page',
      title: tr('notifications.contextQBPage'),
      contexts: ['page'],
      documentUrlPatterns: [
        '*://e-hentai.org/g/*',
        '*://*.e-hentai.org/g/*',
        '*://exhentai.org/g/*',
        '*://*.exhentai.org/g/*'
      ]
    });

    chrome.contextMenus.create({
      id: 'tsukihi-download-qb-link',
      title: tr('notifications.contextQBLink'),
      contexts: ['link'],
      targetUrlPatterns: [
        '*://e-hentai.org/g/*',
        '*://*.e-hentai.org/g/*',
        '*://exhentai.org/g/*',
        '*://*.exhentai.org/g/*'
      ]
    });
  });
}

function ensurePollAlarm() {
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: 0.5 });
}

function openDownloadCenter() {
  chrome.tabs.create({ url: chrome.runtime.getURL('downloads.html') });
}

/**
 * Messaging.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  let responseSent = false;
  const timeoutMs = request?.type === 'getTabState' || request?.type === 'getTabInfo'
    ? 10 * 1000
    : request?.type === 'testQBConnection' ? 28 * 1000 : 60 * 1000;
  const timeoutId = setTimeout(() => {
    responseSent = true;
    sendResponse({ ok: false, error: tr('notifications.backgroundTimeout') });
  }, timeoutMs);

  handleMessage(request, sender)
    .then((response) => {
      if (!responseSent) {
        responseSent = true;
        sendResponse(response);
      }
    })
    .catch((error) => {
      console.error('Tsukihi message error:', error);
      if (!responseSent) {
        responseSent = true;
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })
    .finally(() => clearTimeout(timeoutId));
  return true;
});

async function handleMessage(request, sender) {
  switch (request?.type) {
    case 'getTabInfo':
      return getTabState(request.tab);

    case 'getTabState':
      return getTabState(request.tab);

    case 'startDownload':
      return beginDownload(request.tab, request.mode === 'qb' ? 'qb' : 'lrr', {
        notify: false,
        associateTab: true
      });

    case 'batchDownload': {
      const tabs = Array.isArray(request.tabs) ? request.tabs : [];
      let queued = 0;
      for (const tab of tabs) {
        const result = await beginDownload(tab, 'lrr', {
          notify: false,
          associateTab: true,
          batch: true
        });
        if (result.ok) queued += 1;
      }
      if (queued > 0) {
        showNotification(tr('notifications.batchStarted'), tr('notifications.batchCreated', { count: queued }));
      }
      return { ok: queued > 0, count: queued, error: queued ? null : tr('notifications.noNewTabs') };
    }

    case 'getDownloadTasks':
      await waitForTaskWrites();
      return getDownloadTasksPayload();

    case 'refreshDownloadTasks':
      await refreshActiveTasks();
      return getDownloadTasksPayload();

    case 'clearFinishedTasks': {
      const removed = await clearFinishedTasks();
      return { ok: true, removed };
    }

    case 'recheckTab': {
      if (request.tab?.id) {
        tabHashmap.delete(request.tab.id);
        await onNewUrl(request.tab, true);
      }
      return getTabState(request.tab);
    }

    case 'testQBConnection':
      return testQBConnection(request.settings || {});

    case 'openDownloadCenter':
      openDownloadCenter();
      return { ok: true };

    case 'getActiveTab':
      return { ok: true, tab: await getActiveTab() };

    default:
      return { ok: false, error: `Unknown message type: ${request?.type}` };
  }
}

async function getTabState(tab) {
  if (!tab?.id) {
    return {
      ok: false,
      error: 'No active tab was provided.'
    };
  }

  let tabInfo = tabHashmap.get(tab.id) || null;
  if (!tabInfo) {
    tabInfo = {
      status: 'checking',
      message: tr('notifications.checkingPage')
    };
    onNewUrl(tab).catch((error) => {
      console.warn('Initial tab check failed:', error);
    });
  }

  await waitForTaskWrites();
  const tasks = await readTasks();
  const task = tasks.find((item) => item.tabId === tab.id && item.url === tab.url)
    || tasks.find((item) => item.tabId === tab.id && !item.url)
    || null;
  const settings = await getSettings();

  return {
    ok: true,
    tabInfo,
    task,
    isEHentai: isEHentaiUrl(tab.url),
    settings: {
      server: settings.server,
      qbServer: settings.qbServer,
      enableQB: settings.enableQB,
      qbConfigured: isQBConfigured(settings)
    }
  };
}

async function getDownloadTasksPayload() {
  await waitForTaskWrites();
  const [tasks, settings] = await Promise.all([readTasks(), getSettings()]);
  return {
    ok: true,
    tasks,
    settings: {
      server: settings.server,
      qbServer: settings.qbServer
    }
  };
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

/**
 * Settings and general auth helpers.
 */

async function getSettings() {
  const result = await storageSyncGet([
    'server',
    'api',
    'categoryID',
    'supportedURLs',
    'closeOnDL',
    'enableQB',
    'qbServer',
    'qbUsername',
    'qbPassword',
    'qbApiKey',
    'qbPath'
  ]);

  return {
    server: normalizeServerUrl(result.server),
    api: result.api || '',
    categoryID: result.categoryID || '',
    supportedURLs: Array.isArray(result.supportedURLs) ? result.supportedURLs : [],
    closeOnDL: Boolean(result.closeOnDL),
    enableQB: result.enableQB !== false,
    qbServer: normalizeServerUrl(result.qbServer),
    qbUsername: (result.qbUsername || '').trim(),
    qbPassword: result.qbPassword || '',
    qbApiKey: (result.qbApiKey || '').trim(),
    qbPath: (result.qbPath || '').trim()
  };
}

function getAuthHeader(apiKey) {
  return { Authorization: `Bearer ${btoa(apiKey || '')}` };
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isQBConfigured(settings) {
  return Boolean(settings.qbServer && (settings.qbApiKey || settings.qbUsername || settings.qbPassword));
}

function isEHentaiUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isGalleryHost = host === 'e-hentai.org'
      || host.endsWith('.e-hentai.org')
      || host === 'exhentai.org'
      || host.endsWith('.exhentai.org');
    return isGalleryHost && /\/g\/\d+\/[a-zA-Z0-9]+(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isDownloadableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Tab checking and badge handling.
 */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    tabHashmap.delete(tabId);
    onNewUrl(tab);
  } else if (changeInfo.status && tabHashmap.has(tabId)) {
    updateBadge(tab, tabHashmap.get(tabId));
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) onNewUrl(tab);
  });
});

async function onNewUrl(tab, bypassRegexes = false) {
  if (!tab?.id || tabHashmap.has(tab.id) || tabChecks.has(tab.id)) return;
  tabChecks.add(tab.id);

  try {
    const settings = await getSettings();
    if (!settings.server) {
      await updateTabInfo(tab, { status: 'other', message: tr('notifications.lrrNotConfigured') });
      return;
    }

    if (bypassRegexes || isUrlSupported(tab, settings.supportedURLs)) {
      await checkUrl(settings.server, settings.api, tab);
    } else {
      await updateTabInfo(tab, {
        status: 'other',
        message: tr('notifications.lrrUnsupported')
      });
    }
  } finally {
    tabChecks.delete(tab.id);
  }
}

function isUrlSupported(tab, urlRegexes) {
  if (!Array.isArray(urlRegexes) || !tab.url) return false;
  return urlRegexes.some((pattern) => {
    try {
      return new RegExp(pattern).test(tab.url);
    } catch {
      return false;
    }
  });
}

async function checkUrl(serverUrl, apiKey, tab) {
  if (!tab.url) {
    await updateTabInfo(tab, { status: 'other', message: tr('notifications.noUrl') });
    return;
  }

  await updateTabInfo(tab, { status: 'checking', message: tr('notifications.checkingPage') });

  try {
    const response = await fetchWithTimeout(
      `${serverUrl}/api/plugins/use?plugin=urlfinder&arg=${encodeURIComponent(tab.url)}`,
      { method: 'POST', headers: getAuthHeader(apiKey) }
    );
    const data = await readJsonResponse(response, tr('notifications.lrrQueryFailed'));
    if (data.success === 1 || data.success === true) {
      await updateTabInfo(tab, { status: 'downloaded', arcId: data.data?.id, downloadKind: 'lrr' });
    } else {
      await updateTabInfo(tab, {
        status: 'other',
        message: data.error || tr('notifications.notSaved')
      });
    }
  } catch (error) {
    await updateTabInfo(tab, { status: 'error', message: error.message || String(error) });
  }
}

async function updateTabInfo(tab, infoObject) {
  if (!tab?.id) return;
  const tabInfo = await getTabById(tab.id);
  if (!tabInfo) {
    tabHashmap.delete(tab.id);
    return;
  }

  updateBadge(tabInfo, infoObject);
  tabHashmap.set(tab.id, infoObject);
  if (tabInfo.active) {
    chrome.runtime.sendMessage({ type: 'updateFromBackground', data: infoObject }, () => {
      void chrome.runtime.lastError;
    });
  }
}

function updateBadge(tab, info) {
  let color = 'rgb(54, 57, 64)';
  let text = '';

  switch (info?.status) {
    case 'downloaded':
      text = '✓';
      color = 'rgb(22, 163, 74)';
      break;
    case 'downloading':
      text = info.qbProgress != null ? `${Math.round(info.qbProgress)}%` : `#${info.jobId ?? '…'}`;
      color = 'rgb(37, 99, 235)';
      break;
    case 'checking':
      text = '…';
      color = 'rgb(245, 158, 11)';
      break;
    case 'error':
      text = '!';
      color = 'rgb(220, 38, 38)';
      break;
    case 'other':
      text = '×';
      color = 'rgb(100, 116, 139)';
      break;
  }

  chrome.action.setBadgeBackgroundColor({ color, tabId: tab.id });
  chrome.action.setBadgeText({ text, tabId: tab.id });
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab);
    });
  });
}

/**
 * Download task store.
 */

async function createTask({ source, tab, title, url, batch, notify, associateTab }) {
  const now = Date.now();
  const task = {
    id: makeId(),
    source,
    status: source === 'qb' ? 'starting' : 'starting',
    statusText: tr('notifications.creatingTask'),
    title: title || tab?.title || url,
    url,
    tabId: associateTab === false ? null : tab?.id ?? null,
    tabTitle: tab?.title || '',
    createdAt: now,
    updatedAt: now,
    batch: Boolean(batch),
    notifyOnComplete: !batch,
    progress: 0,
    qb: source === 'qb' ? {
      tag: '',
      hash: '',
      torrentAcquired: false,
      files: []
    } : null,
    lrr: source === 'lrr' ? {
      jobId: null,
      state: 'queued'
    } : null
  };

  if (source === 'qb') {
    task.qb.tag = makeQBTag(task.id);
  }

  await mutateTasks((tasks) => {
    tasks.unshift(task);
    return task;
  });

  return task;
}

async function updateTask(taskId, updater) {
  return mutateTasks((tasks) => {
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    const current = tasks[index];
    const patch = updater({ ...current, qb: current.qb ? { ...current.qb } : null }) || {};
    const updated = {
      ...current,
      ...patch,
      qb: patch.qb ? { ...current.qb, ...patch.qb } : current.qb,
      lrr: patch.lrr ? { ...current.lrr, ...patch.lrr } : current.lrr,
      updatedAt: Date.now()
    };
    tasks[index] = updated;
    return updated;
  });
}

async function getTask(taskId) {
  await waitForTaskWrites();
  const tasks = await readTasks();
  return tasks.find((task) => task.id === taskId) || null;
}

async function mutateTasks(mutator) {
  const operation = taskMutationQueue.then(async () => {
    const tasks = await readTasks();
    const result = await mutator(tasks);
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    trimTaskHistory(tasks);
    taskCache = tasks;
    await storageLocalSet({ [TASKS_STORAGE_KEY]: tasks });
    return result;
  });

  taskMutationQueue = operation.catch((error) => {
    console.error('Task store write failed:', error);
  });
  return operation;
}

async function readTasks() {
  if (taskCache) return taskCache;
  const result = await storageLocalGet(TASKS_STORAGE_KEY);
  taskCache = Array.isArray(result[TASKS_STORAGE_KEY]) ? result[TASKS_STORAGE_KEY] : [];
  return taskCache;
}

async function waitForTaskWrites() {
  await taskMutationQueue.catch(() => {});
}

function trimTaskHistory(tasks) {
  if (tasks.length <= TASK_LIMIT) return;
  const removable = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => !ACTIVE_STATUSES.has(task.status))
    .slice(-Math.max(0, tasks.length - TASK_LIMIT));
  for (const entry of removable.reverse()) {
    tasks.splice(entry.index, 1);
  }
}

async function clearFinishedTasks() {
  return mutateTasks((tasks) => {
    const before = tasks.length;
    const remaining = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    tasks.splice(0, tasks.length, ...remaining);
    return before - remaining.length;
  });
}

async function refreshActiveTasks() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    await waitForTaskWrites();
    const tasks = await readTasks();
    const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    await Promise.allSettled(active.map(async (task) => {
      if (task.source !== 'qb') return refreshLRRTask(task.id);

      const isPreparing = ['starting', 'fetchingTorrent', 'adding'].includes(task.status)
        && !task.qb?.addStartedAt;
      if (isPreparing) {
        if (runningQBTasks.has(task.id)) return null;
        const settings = await getSettings();
        return runQBittorrentTask(task, settings);
      }

      return refreshQBTask(task.id);
    }));
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * Starting downloads.
 */

async function beginDownload(tab, requestedMode, options = {}) {
  const mode = requestedMode === 'qb' ? 'qb' : 'lrr';
  const url = tab?.url;

  if (!isDownloadableUrl(url)) {
    return { ok: false, error: tr('notifications.onlyHttp') };
  }

  if (mode === 'qb' && !isEHentaiUrl(url)) {
    return { ok: false, error: tr('notifications.qbGalleryOnly') };
  }

  const settings = await getSettings();
  if (mode === 'lrr' && !settings.server) {
    return { ok: false, error: tr('notifications.lrrNotConfigured') };
  }
  if (mode === 'qb' && !settings.enableQB) {
    return { ok: false, error: tr('notifications.qbDisabled') };
  }
  if (mode === 'qb' && !isQBConfigured(settings)) {
    return { ok: false, error: tr('notifications.qbNotConfigured') };
  }

  await waitForTaskWrites();
  const existingTask = (await readTasks()).find((item) => (
    item.url === url
    && item.source === mode
    && ACTIVE_STATUSES.has(item.status)
  ));
  if (existingTask) {
    return {
      ok: false,
      taskId: existingTask.id,
      error: mode === 'qb'
        ? tr('notifications.existingQB')
        : tr('notifications.existingLRR')
    };
  }

  const task = await createTask({
    source: mode,
    tab,
    title: tab.title || url,
    url,
    batch: options.batch,
    notify: options.notify,
    associateTab: options.associateTab
  });

  if (options.associateTab !== false) {
    await updateTabInfo(tab, {
      status: 'downloading',
      downloadKind: mode,
      taskId: task.id,
      qbProgress: mode === 'qb' ? 0 : null,
      message: mode === 'qb' ? tr('notifications.preparingQB') : tr('notifications.sendingLRR')
    });
  }

  if (options.notify) {
    showNotification(
      mode === 'qb' ? tr('notifications.qbStarted') : tr('notifications.lrrStarted'),
      truncate(task.title || url, 120)
    );
  }

  runDownloadTask(task.id, settings).catch((error) => {
    failTask(task.id, error.message || String(error)).catch(console.error);
  });

  return {
    ok: true,
    taskId: task.id,
    task,
    message: mode === 'qb' ? tr('notifications.qbTaskStarted') : tr('notifications.lrrTaskStarted')
  };
}

async function runDownloadTask(taskId, settings) {
  const task = await getTask(taskId);
  if (!task) return;
  if (task.source === 'qb') {
    await runQBittorrentTask(task, settings);
  } else {
    await runLANraragiTask(task, settings);
  }
}

/**
 * LANraragi direct URL download.
 */

async function runLANraragiTask(task, settings) {
  if (!settings.server) {
    await failTask(task.id, tr('notifications.lrrNotConfigured'));
    return;
  }

  const formData = new FormData();
  formData.append('url', task.url);
  if (settings.categoryID) formData.append('catid', settings.categoryID);

  try {
    const response = await fetchWithTimeout(`${settings.server}/api/download_url`, {
      method: 'POST',
      body: formData,
      headers: getAuthHeader(settings.api)
    });
    const data = await readJsonResponse(response, tr('notifications.lrrDownloadRequestFailed'));

    if (!data.success) {
      throw new Error(data.message || data.error || tr('notifications.lrrRejected'));
    }

    const jobId = data.job;
    const updated = await updateTask(task.id, () => ({
      status: 'queued',
      statusText: tr('notifications.queuedLRR'),
      lrr: { jobId, state: 'queued' }
    }));

    await updateTaskTabInfo(updated, {
      status: 'downloading',
      downloadKind: 'lrr',
      jobId,
      taskId: task.id
    });
  } catch (error) {
    await failTask(task.id, error.message || String(error));
  }
}

async function refreshLRRTask(taskId) {
  const task = await getTask(taskId);
  if (!task || task.source !== 'lrr' || !ACTIVE_STATUSES.has(task.status)) return;
  if (!task.lrr?.jobId) {
    if (Date.now() - task.createdAt > 90 * 1000) {
      await failTask(task.id, tr('notifications.lrrNoJob'));
    }
    return;
  }

  const settings = await getSettings();
  if (!settings.server) {
    await updateTask(task.id, () => ({
      statusText: tr('notifications.lrrConfigRemoved'),
      lrr: { state: 'configuration-error' }
    }));
    return;
  }

  try {
    const response = await fetchWithTimeout(`${settings.server}/api/minion/${task.lrr.jobId}/detail`, {
      method: 'GET',
      headers: getAuthHeader(settings.api)
    });
    const data = await readJsonResponse(response, tr('notifications.cannotReadLRR'));

    if (data.state === 'failed') {
      const message = typeof data.result === 'string'
        ? data.result
        : data.error || tr('notifications.lrrTaskFailed');
      await failTask(task.id, message);
      return;
    }

    if (data.state !== 'finished') {
      await updateTask(task.id, () => ({
        status: 'processing',
        statusText: tr('notifications.lrrProcessing'),
        lrr: { state: data.state || 'processing' }
      }));
      return;
    }

    const result = normalizeJobResult(data.result);
    if (result?.success === 1 || result?.success === true) {
      await completeLRRTask(task.id, result);
    } else {
      await failTask(task.id, result?.message || result?.error || tr('notifications.lrrDownloadFailed'));
    }
  } catch (error) {
    const failures = Number(task.lrr?.pollFailures || 0) + 1;
    if (failures >= 30) {
      await failTask(task.id, tr('notifications.lrrProgressFailed', { error: error.message || error }));
      return;
    }
    await updateTask(task.id, () => ({
      statusText: tr('notifications.lrrProgressTemporary', { error: error.message || error }),
      lrr: { state: 'connection-error', pollFailures: failures }
    }));
  }
}

async function completeLRRTask(taskId, result) {
  const current = await getTask(taskId);
  if (!current || current.status === 'completed') return;

  const updated = await updateTask(taskId, () => ({
    status: 'completed',
    statusText: tr('notifications.savedLRR'),
    progress: 100,
    completedAt: Date.now(),
    lrr: { arcId: result.id, state: 'finished' }
  }));

  await updateTaskTabInfo(updated, {
    status: 'downloaded',
    downloadKind: 'lrr',
    arcId: result.id,
    taskId
  });

  if (!current.completionNotified) {
    await updateTask(taskId, () => ({ completionNotified: true }));
    if (updated?.notifyOnComplete) {
      showNotification(tr('notifications.lrrComplete'), truncate(updated.title, 90));
    }
  }
  await closeTabIfConfigured(updated);
}

/**
 * E-Hentai torrent discovery and qBittorrent integration.
 */

async function runQBittorrentTask(task, settings) {
  if (runningQBTasks.has(task.id)) return;
  runningQBTasks.add(task.id);

  try {
    await updateTask(task.id, () => ({
      status: 'fetchingTorrent',
      statusText: tr('notifications.parsingGallery')
    }));

    const torrentInfo = await fetchEHentaiTorrentInfo(task.url);
    const prepared = await updateTask(task.id, () => ({
      title: torrentInfo.galleryName,
      status: 'adding',
      statusText: tr('notifications.sendingTorrent'),
      torrent: {
        galleryName: torrentInfo.galleryName,
        sourceFilename: torrentInfo.filename,
        targetFilename: torrentInfo.targetFilename,
        torrentUrl: torrentInfo.torrentUrl
      }
    }));

    await updateTaskTabInfo(prepared, {
      status: 'downloading',
      downloadKind: 'qb',
      taskId: task.id,
      qbProgress: 0,
      qbName: torrentInfo.galleryName,
      message: tr('notifications.sendingTorrent'),
    });

    const preHashes = await getQBHashes(settings);
    let added;
    try {
      added = await addTorrentToQB(settings, {
        torrentUrl: torrentInfo.torrentUrl,
        savePath: settings.qbPath,
        tag: task.qb.tag
      });
    } catch (addError) {
      const existing = await findQBTorrentByTitle(settings, torrentInfo.galleryName);
      if (!existing) throw addError;

      const existingAcquired = existing.has_metadata !== false
        && existing.state !== 'metaDL'
        && existing.state !== 'forcedMetaDL';
      await updateTask(task.id, () => ({
        status: existingAcquired ? 'downloading' : 'awaitingMetadata',
        statusText: existingAcquired
          ? tr('notifications.qbExistingTorrent')
          : tr('notifications.qbExistingTask'),
        qb: {
          hash: existing.hash,
          name: existing.name || torrentInfo.galleryName,
          torrentAcquired: existingAcquired
        }
      }));
      await refreshQBTask(task.id);
      return;
    }

    await updateTask(task.id, () => ({
      status: 'awaitingTorrent',
      statusText: added.hash
        ? tr('notifications.qbAcceptedConfirming')
        : tr('notifications.qbFetchingTorrent'),
      qb: {
        hash: added.hash || '',
        addAcceptedAt: Date.now(),
        addStartedAt: added.startedAt,
        addResponse: added.response,
        torrentAcquired: false
      }
    }));

    const identified = await waitForQBTorrentIdentity(task.id, settings, {
      preHashes,
      startedAt: added.startedAt
    });

    if (identified) {
      await refreshQBTask(task.id);
    }
  } catch (error) {
    await failTask(task.id, error.message || String(error));
  } finally {
    runningQBTasks.delete(task.id);
  }
}

async function fetchEHentaiTorrentInfo(galleryUrl) {
  const parsed = new URL(galleryUrl);
  const match = parsed.pathname.match(/\/g\/(\d+)\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error(tr('notifications.invalidGallery'));

  const gid = match[1];
  const token = match[2];
  const origins = [...new Set([parsed.origin, 'https://e-hentai.org'])];
  let html = '';
  let lastError = null;

  for (const origin of origins) {
    try {
      const response = await fetchWithTimeout(
        `${origin}/gallerytorrents.php?gid=${encodeURIComponent(gid)}&t=${encodeURIComponent(token)}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error(tr('notifications.torrentPageHttp', { status: response.status }));
      html = await response.text();
      if (html) break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!html) {
    throw new Error(tr('notifications.openTorrentPageFailed', { error: lastError?.message || tr('notifications.emptyResponse') }));
  }

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const galleryName = titleMatch
    ? decodeHtml(stripHtml(titleMatch[1])).trim()
    : `E-Hentai gallery ${gid}`;

  const outdatedIndex = html.indexOf('Outdated Torrents:');
  const currentArea = outdatedIndex > 0 ? html.slice(0, outdatedIndex) : html;
  const torrents = parseTorrentAnchors(currentArea, parsed.origin);

  if (torrents.length === 0) {
    throw new Error(tr('notifications.noTorrent'));
  }

  const archiveExtensions = ['.zip', '.rar', '.7z', '.tar.gz', '.tar', '.gz', '.torrent'];
  const selected = torrents.find((torrent) => (
    archiveExtensions.some((extension) => torrent.filename.toLowerCase().endsWith(extension))
  )) || torrents[0];

  const extensionMatch = selected.filename.match(/(\.(?:tar\.gz|tar\.bz2|zip|rar|7z|gz|torrent))$/i)
    || selected.filename.match(/(\.[^.]+)$/);
  const extension = extensionMatch ? extensionMatch[1] : '';
  const targetFilename = `${galleryName}${extension}`;

  return {
    galleryName,
    torrentUrl: selected.url,
    filename: selected.filename,
    targetFilename,
    torrentCount: torrents.length
  };
}

function parseTorrentAnchors(html, origin) {
  const torrents = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch;

  while ((anchorMatch = anchorPattern.exec(html)) !== null) {
    const attributes = anchorMatch[1];
    const label = decodeHtml(stripHtml(anchorMatch[2])).trim();
    const hrefMatch = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const onclickMatch = attributes.match(/\bonclick\s*=\s*["'][^"']*(https:\/\/ehtracker\.org\/get\/[^"']+\.torrent)[^"']*["']/i);
    let url = hrefMatch?.[1] || onclickMatch?.[1] || '';

    if (!url || !/\.torrent(?:[?#]|$)/i.test(url)) continue;
    try {
      url = new URL(decodeHtml(url), origin).href;
    } catch {
      continue;
    }

    if (!/ehtracker\.org\/get\//i.test(url) && !/\.torrent(?:[?#]|$)/i.test(url)) continue;
    torrents.push({
      url,
      filename: label || decodeURIComponent(url.split('/').pop() || 'gallery.torrent')
    });
  }

  return torrents;
}

async function addTorrentToQB(settings, { torrentUrl, savePath, tag }) {
  const startedAt = Math.floor(Date.now() / 1000);
  const formData = new FormData();
  formData.append('urls', torrentUrl);
  if (savePath) {
    formData.append('savepath', savePath);
    formData.append('autoTMM', 'false');
  }
  if (tag) formData.append('tags', tag);

  const response = await qbApiFetch(settings, '/api/v2/torrents/add', {
    method: 'POST',
    body: formData
  });
  const text = await response.text();

  if (!response.ok) {
    if (response.status === 415) {
      throw new Error(tr('notifications.invalidTorrent'));
    }
    if (response.status === 409) {
      throw qbError(tr('notifications.qbRejected409'), 'QB_ADD_FAILED');
    }
    throw new Error(tr('notifications.qbAddFailed', { status: response.status, detail: truncate(text, 160) }));
  }

  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      // qBittorrent 5.0 and older return plain text.
    }
  }

  if (data && typeof data === 'object') {
    const successCount = Number(data.success_count || 0);
    const failureCount = Number(data.failure_count || 0);
    const pendingCount = Number(data.pending_count || 0);
    const hashes = Array.isArray(data.added_torrent_ids) ? data.added_torrent_ids : [];

    if (successCount === 0 && pendingCount === 0 && failureCount > 0) {
      throw new Error(tr('notifications.qbRejectedDuplicate'));
    }
    if (successCount === 0 && pendingCount === 0 && hashes.length === 0) {
      throw new Error(tr('notifications.qbEmptyAdd'));
    }

    return {
      hash: hashes[0] || '',
      pending: pendingCount > 0,
      response: data,
      startedAt
    };
  }

  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith('fails')) {
    throw qbError(tr('notifications.qbRejectedFails'), 'QB_ADD_FAILED');
  }
  if (response.status === 202 || !normalized || normalized.startsWith('ok')) {
    return {
      hash: '',
      pending: true,
      response: text.trim() || 'OK',
      startedAt
    };
  }

  throw new Error(tr('notifications.qbUnknownAdd', { detail: truncate(text, 160) }));
}

async function waitForQBTorrentIdentity(taskId, settings, { preHashes, startedAt }) {
  const deadline = Date.now() + 90 * 1000;

  while (Date.now() < deadline) {
    const task = await getTask(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) return null;
    if (task.qb?.hash) return task.qb.hash;

    try {
      const torrent = await findQBTorrentForTask(settings, task, { preHashes, startedAt });
      if (torrent?.hash) {
        await updateTask(taskId, () => ({
          status: 'awaitingMetadata',
          statusText: torrent.has_metadata === false || torrent.state === 'metaDL'
            ? tr('notifications.torrentAcquiredMetadata')
            : tr('notifications.torrentAcquired'),
          qb: {
            hash: torrent.hash,
            name: torrent.name || task.title,
            torrentAcquired: torrent.has_metadata !== false
              && torrent.state !== 'metaDL'
              && torrent.state !== 'forcedMetaDL'
          }
        }));
        return torrent.hash;
      }
    } catch (error) {
      if (isQBAuthError(error)) throw error;
      console.warn('Could not identify qB torrent yet:', error);
    }

    await sleep(2500);
  }

  const current = await getTask(taskId);
  if (current && ACTIVE_STATUSES.has(current.status)) {
    throw new Error(tr('notifications.qbNoTorrent90'));
  }
  return null;
}

async function refreshQBTask(taskId) {
  const task = await getTask(taskId);
  if (!task || task.source !== 'qb' || !ACTIVE_STATUSES.has(task.status)) return;

  const settings = await getSettings();
  if (!isQBConfigured(settings)) {
    await failTask(task.id, tr('notifications.qbConfigInvalid'));
    return;
  }

  try {
    if (!task.qb?.hash) {
      const torrent = await findQBTorrentForTask(settings, task, {
        preHashes: Array.isArray(task.qb?.preHashes) ? new Set(task.qb.preHashes) : null,
        startedAt: task.qb?.addStartedAt
      });
      if (!torrent?.hash) {
        if (Date.now() - task.createdAt > QB_TORRENT_TIMEOUT_MS) {
          await failTask(task.id, tr('notifications.qbNoTorrentTimeout'));
        } else {
          await updateTask(task.id, () => ({
            status: 'awaitingTorrent',
            statusText: tr('notifications.qbFetchingTorrentStatus')
          }));
        }
        return;
      }

      await updateTask(task.id, () => ({ qb: { hash: torrent.hash } }));
      task.qb.hash = torrent.hash;
    }

    const infoResponse = await qbApiFetch(
      settings,
      `/api/v2/torrents/info?hashes=${encodeURIComponent(task.qb.hash)}`
    );
    if (!infoResponse.ok) {
      throw new Error(tr('notifications.qbStatusFailed', { status: infoResponse.status }));
    }

    const torrents = await infoResponse.json();
    if (!Array.isArray(torrents) || torrents.length === 0) {
      const missingCount = Number(task.qb.missingCount || 0) + 1;
      if (missingCount >= 4 || Date.now() - task.createdAt > QB_TORRENT_TIMEOUT_MS) {
        await failTask(task.id, tr('notifications.torrentDisappeared'));
      } else {
        await updateTask(task.id, () => ({
          status: 'awaitingTorrent',
          statusText: tr('notifications.waitingQBMetadata'),
          qb: { missingCount }
        }));
      }
      return;
    }

    const torrent = torrents[0];
    const state = torrent.state || 'unknown';
    const progress = clamp(Number(torrent.progress || 0) * 100, 0, 100);
    const totalSize = Number(torrent.total_size || torrent.size || 0);
    const downloadedBytes = totalSize > 0
      ? Math.round(totalSize * (progress / 100))
      : Number(torrent.downloaded || 0);
    const hasMetadata = torrent.has_metadata !== false
      && state !== 'metaDL'
      && state !== 'forcedMetaDL';
    const torrentAcquired = hasMetadata && Boolean(torrent.name || totalSize > 0);
    const isComplete = progress >= 99.99
      && state !== 'moving'
      && !QB_ERROR_STATES.has(state);

    if (QB_ERROR_STATES.has(state)) {
      const detail = torrent.error || qbStateLabel(state);
      await failTask(task.id, tr('notifications.qbErrorPrefix', { detail }));
      return;
    }

    let filePatch = {};
    const lastFilesFetch = Number(task.qb.filesFetchedAt || 0);
    if (torrentAcquired && (!isComplete || !Array.isArray(task.qb.files) || task.qb.files.length === 0)
      && Date.now() - lastFilesFetch > 8000) {
      try {
        const files = await fetchQBTorrentFiles(settings, task.qb.hash);
        filePatch = {
          files: files.slice(0, 40),
          fileCount: files.length,
          hiddenFileCount: Math.max(0, files.length - 40),
          filesFetchedAt: Date.now()
        };
      } catch (error) {
        console.warn('Could not fetch qB file progress:', error);
      }
    }

    const statusText = !torrentAcquired
      ? tr('notifications.qbAcceptedFetching')
      : isComplete
        ? tr('notifications.qbComplete')
        : qbStateLabel(state);

    const updated = await updateTask(task.id, () => ({
      status: isComplete ? 'completed' : 'downloading',
      statusText,
      progress,
      completedAt: isComplete ? Date.now() : task.completedAt,
      qb: {
        hash: torrent.hash || task.qb.hash,
        name: torrent.name || task.title,
        torrentAcquired,
        acquiredAt: torrentAcquired ? (task.qb.acquiredAt || Date.now()) : task.qb.acquiredAt,
        state,
        stateLabel: qbStateLabel(state),
        progress,
        size: totalSize,
        downloadedBytes,
        amountLeft: Number(torrent.amount_left || Math.max(0, totalSize - downloadedBytes)),
        speed: Number(torrent.dlspeed || 0),
        eta: Number(torrent.eta || 0),
        seeds: Number(torrent.num_seeds || 0),
        peers: Number(torrent.num_leechs || 0),
        savePath: torrent.save_path || '',
        contentPath: torrent.content_path || '',
        missingCount: 0,
        pollFailures: 0,
        ...filePatch
      }
    }));

    if (!updated) return;

    if (isComplete) {
      await updateTaskTabInfo(updated, {
        status: 'downloaded',
        downloadKind: 'qb',
        taskId: updated.id,
        qbName: updated.qb?.name || updated.title
      });
      await notifyQBCompletion(updated);
    } else {
      await updateTaskTabInfo(updated, {
        status: 'downloading',
        downloadKind: 'qb',
        taskId: updated.id,
        qbProgress: progress,
        qbState: state,
        qbName: updated.qb?.name || updated.title,
        qbAcquired: torrentAcquired,
        qbSpeed: Number(torrent.dlspeed || 0),
        qbEta: Number(torrent.eta || 0)
      });
    }
  } catch (error) {
    if (isQBAuthError(error)) {
      await failTask(task.id, error.message);
      return;
    }

    const failures = Number(task.qb?.pollFailures || 0) + 1;
    if (failures >= 5) {
      await failTask(task.id, tr('notifications.qbProgressFailed', { error: error.message || error }));
    } else {
      await updateTask(task.id, () => ({
        statusText: tr('notifications.qbTemporarilyUnavailable'),
        qb: { pollFailures: failures }
      }));
    }
  }
}

async function notifyQBCompletion(task) {
  if (task.completionNotified) return;
  await updateTask(task.id, () => ({ completionNotified: true }));
  if (task.notifyOnComplete) {
    showNotification(
      tr('notifications.qbComplete'),
      `${task.qb?.name || task.title}${task.qb?.torrentAcquired ? tr('notifications.torrentAcquired') : ''}`
    );
  }
  await closeTabIfConfigured(task);
}

async function fetchQBTorrentFiles(settings, hash) {
  const response = await qbApiFetch(
    settings,
    `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const files = await response.json();
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({
    index: Number(file.index || 0),
    name: file.name || '',
    size: Number(file.size || 0),
    progress: clamp(Number(file.progress || 0) * 100, 0, 100),
    priority: Number(file.priority || 0),
    isSeed: Boolean(file.is_seed)
  }));
}

async function findQBTorrentForTask(settings, task, options = {}) {
  const identified = await findQBTorrent(settings, task, options);
  if (identified) return identified;
  const title = task.torrent?.galleryName || task.qb?.name || task.title;
  return title ? findQBTorrentByTitle(settings, title) : null;
}

async function findQBTorrentByTitle(settings, title) {
  try {
    const response = await qbApiFetch(settings, '/api/v2/torrents/info');
    if (!response.ok) return null;
    const torrents = await response.json();
    if (!Array.isArray(torrents)) return null;

    const target = normalizeTorrentTitle(title);
    if (!target) return null;
    return torrents.find((torrent) => normalizeTorrentTitle(torrent.name) === target)
      || torrents.find((torrent) => normalizeTorrentTitle(torrent.name).includes(target))
      || null;
  } catch (error) {
    if (isQBAuthError(error)) throw error;
    return null;
  }
}

function normalizeTorrentTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function findQBTorrent(settings, task, options = {}) {
  if (task.qb?.hash) {
    const response = await qbApiFetch(
      settings,
      `/api/v2/torrents/info?hashes=${encodeURIComponent(task.qb.hash)}`
    );
    if (!response.ok) throw await qbResponseError(response, tr('notifications.qbQueryFailed'));
    const torrents = await response.json();
    if (Array.isArray(torrents) && torrents.length > 0) return torrents[0];
  }

  if (task.qb?.tag) {
    try {
      const response = await qbApiFetch(
        settings,
        `/api/v2/torrents/info?tag=${encodeURIComponent(task.qb.tag)}`
      );
      if (response.ok) {
        const torrents = await response.json();
        if (Array.isArray(torrents) && torrents.length > 0) return torrents[0];
      }
    } catch (error) {
      if (isQBAuthError(error)) throw error;
    }
  }

  if (!options.preHashes && !options.startedAt) return null;

  const response = await qbApiFetch(settings, '/api/v2/torrents/info');
  if (!response.ok) throw await qbResponseError(response, tr('notifications.qbQueryListFailed'));
  const torrents = await response.json();
  if (!Array.isArray(torrents)) return null;

  return torrents.find((torrent) => (
    (!options.preHashes || !options.preHashes.has(torrent.hash))
    && Number(torrent.added_on || 0) >= Number(options.startedAt || 0) - 2
  )) || null;
}

async function getQBHashes(settings) {
  try {
    const response = await qbApiFetch(settings, '/api/v2/torrents/info');
    if (!response.ok) return new Set();
    const torrents = await response.json();
    return new Set(Array.isArray(torrents) ? torrents.map((torrent) => torrent.hash) : []);
  } catch {
    return new Set();
  }
}

/**
 * qBittorrent API transport, including API key and legacy SID auth.
 */

function qbConfigFrom(value) {
  return {
    qbServer: normalizeServerUrl(value.qbServer),
    qbApiKey: String(value.qbApiKey || '').trim(),
    qbUsername: String(value.qbUsername || '').trim(),
    qbPassword: String(value.qbPassword || '')
  };
}

function qbSessionKey(settings) {
  return `${settings.qbServer}|${settings.qbUsername}|${settings.qbApiKey || 'password'}`;
}

async function qbApiFetch(settings, path, init = {}) {
  const config = qbConfigFrom(settings);
  if (!config.qbServer) throw new Error(tr('notifications.qbNotConfigured'));

  if (config.qbApiKey) {
    return qbApiKeyFetch(config, path, init);
  }

  const sessionKey = qbSessionKey(config);
  if (!qbSessions.has(sessionKey)) {
    await qbLogin(config, sessionKey);
  }

  let response = await qbFetchOnce(config, path, init, null);
  if (response.status === 401 || response.status === 403) {
    qbSessions.delete(sessionKey);
    await qbLogin(config, sessionKey);
    response = await qbFetchOnce(config, path, init, null);
  }

  if (response.status === 401 || response.status === 403) {
    throw qbError(tr('notifications.qbAuthFailed'), 'QB_AUTH');
  }

  return response;
}

async function qbApiKeyFetch(config, path, init) {
  const key = qbSessionKey(config);
  let mode = qbAuthModes.get(key) || 'bearer';
  let response = await qbFetchOnce(config, path, init, mode);

  if ((response.status === 401 || response.status === 403) && mode === 'bearer') {
    mode = 'x-api-key';
    response = await qbFetchOnce(config, path, init, mode);
  }

  if (response.status === 401 || response.status === 403) {
    throw qbError(tr('notifications.qbInvalidKey'), 'QB_AUTH');
  }

  qbAuthModes.set(key, mode);
  return response;
}

async function qbFetchOnce(config, path, init, authMode) {
  const headers = new Headers(init.headers || {});
  headers.set('Referer', config.qbServer);

  if (authMode === 'bearer') {
    headers.set('Authorization', `Bearer ${config.qbApiKey}`);
  } else if (authMode === 'x-api-key') {
    headers.set('X-API-Key', config.qbApiKey);
  }

  return fetchWithTimeout(`${config.qbServer}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: config.qbApiKey ? 'omit' : 'include'
  });
}

async function qbLogin(config, sessionKey) {
  const form = new URLSearchParams();
  form.append('username', config.qbUsername || 'admin');
  form.append('password', config.qbPassword || '');

  const response = await fetchWithTimeout(`${config.qbServer}/api/v2/auth/login`, {
    method: 'POST',
    body: form,
    credentials: 'include',
    headers: { Referer: config.qbServer }
  });
  const text = (await response.text()).trim();

  if (!response.ok || text.toLowerCase().startsWith('fails')) {
    throw qbError(tr('notifications.qbLoginFailed'), 'QB_AUTH');
  }

  qbSessions.add(sessionKey);
}

async function testQBConnection(draft) {
  const settings = qbConfigFrom(draft);
  if (!settings.qbServer) {
    return { ok: false, error: tr('notifications.enterQBUrl') };
  }
  if (!settings.qbApiKey && !settings.qbUsername && !settings.qbPassword) {
    return { ok: false, error: tr('notifications.enterQBAuth') };
  }

  try {
    const versionResponse = await qbApiFetch(settings, '/api/v2/app/version');
    if (!versionResponse.ok) {
      throw await qbResponseError(versionResponse, tr('notifications.qbConnectionTestFailed'));
    }
    const version = (await versionResponse.text()).trim();
    if (!version) {
      throw new Error(tr('notifications.qbEmptyVersion'));
    }

    let apiVersion = '';
    try {
      const apiResponse = await qbApiFetch(settings, '/api/v2/app/webapiVersion');
      if (apiResponse.ok) apiVersion = (await apiResponse.text()).trim();
    } catch {
      // Version is optional for the settings screen.
    }

    return {
      ok: true,
      version,
      apiVersion,
      authMode: settings.qbApiKey ? 'api-key' : 'password',
      message: settings.qbApiKey
        ? tr('options.qbConnected', { method: tr('options.apiKeyMethod'), version })
        : tr('options.qbConnected', { method: tr('options.passwordMethod'), version })
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function qbError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isQBAuthError(error) {
  return error?.code === 'QB_AUTH';
}

async function qbResponseError(response, prefix) {
  let detail = '';
  try {
    detail = (await response.text()).trim();
  } catch {
    // Ignore response body read failures.
  }
  return new Error(`${prefix} (HTTP ${response.status})${detail ? `: ${truncate(detail, 160)}` : ''}`);
}

/**
 * Task completion and errors.
 */

async function updateTaskTabInfo(task, infoObject) {
  if (!task?.tabId) return;
  const tab = await getTabById(task.tabId);
  if (!tab || (task.url && tab.url !== task.url)) return;
  await updateTabInfo(tab, infoObject);
}

async function failTask(taskId, message) {
  const current = await getTask(taskId);
  if (!current || current.status === 'error' || current.status === 'completed') return;

  const updated = await updateTask(taskId, () => ({
    status: 'error',
    statusText: tr('notifications.downloadFailed'),
    error: message,
    failedAt: Date.now()
  }));

  await updateTaskTabInfo(updated, {
    status: 'error',
    downloadKind: updated.source,
    taskId,
    message
  });

  if (!current.errorNotified) {
    await updateTask(taskId, () => ({ errorNotified: true }));
    if (updated?.notifyOnComplete) {
      showNotification(
        updated?.source === 'qb' ? tr('notifications.qbDownloadFailed') : tr('notifications.lrrDownloadFailed'),
        truncate(message, 160)
      );
    }
  }
}

async function closeTabIfConfigured(task) {
  if (!task?.tabId) return;
  const settings = await getSettings();
  if (!settings.closeOnDL) return;

  const tab = await getTabById(task.tabId);
  if (tab && (!task.url || tab.url === task.url)) chrome.tabs.remove(task.tabId);
}

/**
 * Utility functions.
 */

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeQBTag(taskId) {
  return `tsukihi-${taskId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    const responseBody = [204, 205, 304].includes(response.status) ? null : body;
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (error) {
    if (controller.signal.aborted) {
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = tr('notifications.server');
      }
      throw new Error(tr('notifications.connectionTimeout', { host, seconds: Math.round(timeoutMs / 1000) }));
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(tr('notifications.nonJson', { message: fallbackMessage }));
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `${fallbackMessage}（HTTP ${response.status}）`);
  }

  return data;
}

function normalizeJobResult(result) {
  if (!result) return null;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return { message: result };
    }
  }
  return result;
}

function storageSyncGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageLocalGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageLocalSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function showNotification(title, message) {
  const options = {
    type: 'basic',
    title: truncate(title, 60),
    message: truncate(typeof message === 'string' ? message : JSON.stringify(message), 220),
    iconUrl: 'images/get_started128.png'
  };

  console.log(`[Tsukihi] ${title}: ${options.message}`);
  chrome.notifications?.create(null, options, () => {
    void chrome.runtime.lastError;
  });
}
