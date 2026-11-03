// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

let activeTab = null;
let currentState = null;
let refreshInFlight = false;
let actionInFlight = false;
let toastTimer = null;
let overlayHideTimer = null;
let currentLanguage = TSUKIHI_DEFAULT_LANGUAGE;

const refs = {
  statusCard: document.getElementById('statusCard'),
  statusOrb: document.getElementById('statusOrb'),
  statusGlyph: document.getElementById('statusGlyph'),
  statusEyebrow: document.getElementById('statusEyebrow'),
  statusTitle: document.getElementById('statusTitle'),
  statusDetail: document.getElementById('statusDetail'),
  recheckTab: document.getElementById('recheckTab'),
  batchCard: document.getElementById('batchCard'),
  batchLeft: document.getElementById('downloadLeft'),
  batchRight: document.getElementById('downloadRight'),
  qbTaskCard: document.getElementById('qbTaskCard'),
  qbTaskTitle: document.getElementById('qbTaskTitle'),
  qbPercent: document.getElementById('qbPercent'),
  qbProgressTrack: document.getElementById('qbProgressTrack'),
  qbProgressBar: document.getElementById('qbProgressBar'),
  qbBytes: document.getElementById('qbBytes'),
  qbSpeed: document.getElementById('qbSpeed'),
  qbEta: document.getElementById('qbEta'),
  qbAcquisition: document.getElementById('qbAcquisition'),
  downloadUrl: document.getElementById('downloadUrl'),
  downloadToQB: document.getElementById('downloadToQB'),
  qbActionHint: document.getElementById('qbActionHint'),
  openDownloads: document.getElementById('openDownloads'),
  openDownloadCenter: document.getElementById('openDownloadCenter'),
  allDownloads: document.getElementById('allDownloads'),
  openSettings: document.getElementById('openSettings'),
  languageSelect: document.getElementById('languageSelect'),
  launchOverlay: document.getElementById('launchOverlay'),
  launchVisual: document.getElementById('launchVisual'),
  launchTitle: document.getElementById('launchTitle'),
  launchDetail: document.getElementById('launchDetail'),
  toast: document.getElementById('toast')
};

initialize();

async function initialize() {
  currentLanguage = await tsukihiGetLanguage();
  refs.languageSelect.value = currentLanguage;
  tsukihiApplyPageTranslations(currentLanguage);
  tsukihiBindLanguageSelect(refs.languageSelect, async (language) => {
    currentLanguage = language;
    tsukihiApplyPageTranslations(language);
    if (currentState) renderState(currentState);
  });
  tsukihiWatchLanguage((language) => {
    if (language === currentLanguage) return;
    currentLanguage = language;
    refs.languageSelect.value = language;
    tsukihiApplyPageTranslations(language);
    if (currentState) renderState(currentState);
  });

  activeTab = await queryActiveTab();
  if (!activeTab) {
    setStatus('danger', t('popup.unableReadTab'), t('popup.reopenPopup'), { pulse: false });
    return;
  }

  await refreshState();
  setInterval(refreshState, 1500);

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.type === 'updateFromBackground') {
      refreshState();
    }
  });
}

function t(key, variables = {}) {
  return tsukihiTranslate(currentLanguage, key, variables);
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      settled = true;
      reject(new Error(t('popup.backgroundTimeout', { seconds: Math.round(timeoutMs / 1000) })));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response) {
          reject(new Error(t('popup.backgroundNoResponse')));
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function refreshState() {
  if (!activeTab || refreshInFlight) return;
  refreshInFlight = true;

  try {
    const state = await sendMessage({ type: 'getTabState', tab: activeTab }, 10000);
    if (!state?.ok) throw new Error(state?.error || t('popup.cannotReadState'));
    currentState = state;
    renderState(state);
  } catch (error) {
    console.warn('Could not refresh Tsukihi popup:', error);
    if (!currentState) {
      setStatus('danger', t('popup.backgroundUnavailable'), error.message || String(error));
      refs.downloadUrl.disabled = true;
      refs.downloadToQB.disabled = true;
    }
  } finally {
    refreshInFlight = false;
  }
}

function renderState(state) {
  const task = state.task;
  const tabInfo = state.tabInfo || {};
  const activeTabTask = task && ['starting', 'fetchingTorrent', 'adding', 'awaitingTorrent', 'awaitingMetadata', 'downloading', 'queued', 'processing'].includes(task.status);
  const lrrActiveOrDone = task?.source === 'lrr' && (activeTabTask || task.status === 'completed');
  const qbActiveOrDone = task?.source === 'qb' && (activeTabTask || task.status === 'completed');

  const hideQBForActiveTask = task?.source === 'qb' && activeTabTask;
  const serverReady = Boolean(state.settings.server);
  refs.downloadUrl.disabled = !serverReady || Boolean(lrrActiveOrDone);
  refs.batchLeft.disabled = !serverReady;
  refs.batchRight.disabled = !serverReady;
  refs.batchCard.classList.toggle('hidden', Boolean(task));
  refs.downloadToQB.classList.toggle('hidden', !(state.isEHentai && state.settings.enableQB) || hideQBForActiveTask);
  refs.downloadToQB.disabled = !state.settings.qbConfigured || Boolean(qbActiveOrDone);
  refs.qbActionHint.textContent = state.settings.qbConfigured
    ? t('popup.qbActionHint')
    : t('popup.qbNeedsApiKey');

  if (task) {
    renderTask(task, state);
  } else {
    refs.qbTaskCard.classList.add('hidden');
    renderTabInfo(tabInfo, state);
  }

  refs.recheckTab.classList.toggle('hidden', tabInfo.status === 'checking');
}

function renderTask(task, state) {
  if (task.source === 'qb') {
    renderQBTask(task);
  } else {
    refs.qbTaskCard.classList.add('hidden');
    renderLRRTask(task, state);
  }
}

function renderQBTask(task) {
  const qb = task.qb || {};
  const progress = Number(task.progress ?? qb.progress ?? 0);
  const hasProgress = qb.torrentAcquired || progress > 0 || task.status === 'completed';
  const isWaiting = ['starting', 'fetchingTorrent', 'adding', 'awaitingTorrent', 'awaitingMetadata'].includes(task.status)
    && !qb.torrentAcquired;

  refs.qbTaskCard.classList.remove('hidden');
  refs.qbTaskTitle.textContent = qb.name || task.title || t('popup.qbTask');
  refs.qbPercent.textContent = hasProgress ? `${Math.round(progress)}%` : '—';
  refs.qbProgressTrack.classList.toggle('is-indeterminate', isWaiting);
  refs.qbProgressTrack.classList.toggle('is-complete', task.status === 'completed');
  refs.qbProgressBar.style.width = isWaiting ? '' : `${clamp(progress, 0, 100)}%`;
  refs.qbBytes.textContent = formatQBBytes(qb, progress);
  refs.qbSpeed.textContent = qb.speed > 0 ? formatSpeed(qb.speed) : t('common.waitingForConnection');
  refs.qbEta.textContent = formatEta(qb.eta);

  if (task.status === 'error') {
    refs.qbAcquisition.textContent = t('popup.torrentFailed');
  } else if (task.status === 'completed') {
    refs.qbAcquisition.textContent = qb.torrentAcquired ? t('popup.torrentAcquiredCompleted') : t('popup.downloadCompleted');
  } else if (qb.torrentAcquired) {
    refs.qbAcquisition.textContent = `${t('popup.torrentAcquired')}${qb.fileCount ? t('popup.fileCount', { count: qb.fileCount }) : ''}`;
  } else {
    refs.qbAcquisition.textContent = t('popup.qbFetchingShort');
  }

  let tone = 'running';
  let title = qb.torrentAcquired ? t('popup.qbDownloading') : t('popup.qbProcessing');
  let detail = qb.name || task.title || '';
  let pulse = true;

  if (task.status === 'completed') {
    tone = 'success';
    title = t('popup.qbDownloadComplete');
    detail = qb.torrentAcquired ? t('popup.completeWithTorrent') : t('popup.completeFiles');
    pulse = false;
  } else if (task.status === 'error') {
    tone = 'danger';
    title = t('popup.qbDownloadFailed');
    detail = task.error || task.statusText || t('popup.viewDetailsInCenter');
    pulse = false;
  } else if (!qb.torrentAcquired) {
    tone = 'warning';
    title = task.status === 'fetchingTorrent'
      ? t('popup.parsingTorrent')
      : t('popup.waitingQBTorrent');
    detail = t('popup.progressAfterTorrent');
  }

  setStatus(tone, title, detail, { pulse, eyebrow: t('popup.qbTask') });
}

function renderLRRTask(task, state) {
  if (task.status === 'completed') {
    setStatus('success', t('popup.savedToLRR'), task.title || task.url, { pulse: false, eyebrow: t('popup.lrrTask') });
    appendArchiveLink(task.lrr?.arcId, state.settings.server);
    return;
  }

  if (task.status === 'error') {
    setStatus('danger', t('popup.lrrDownloadFailed'), task.error || task.statusText, { pulse: false, eyebrow: t('popup.lrrTask') });
    return;
  }

  const jobText = task.lrr?.jobId ? t('popup.jobNumber', { id: task.lrr.jobId }) : t('popup.creatingTask');
  setStatus('running', t('popup.lrrProcessing'), `${jobText} · ${task.title || task.url}`, {
    pulse: true,
    eyebrow: t('popup.lrrTask')
  });
}

function renderTabInfo(tabInfo, state) {
  switch (tabInfo.status) {
    case 'downloaded':
      if (tabInfo.downloadKind === 'qb') {
        setStatus('success', t('popup.qbCompleteShort'), tabInfo.qbName || t('popup.torrentFetchedComplete'), {
          pulse: false,
          eyebrow: t('popup.currentPage')
        });
      } else {
        setStatus('success', t('popup.pageSaved'), t('popup.archiveNumber', { id: tabInfo.arcId || t('common.unknown') }), {
          pulse: false,
          eyebrow: t('popup.currentPage')
        });
        appendArchiveLink(tabInfo.arcId, state.settings.server);
        refs.downloadUrl.disabled = true;
      }
      break;

    case 'downloading':
      setStatus('running', t('popup.pageDownloading'), tabInfo.message || t('popup.jobNumber', { id: tabInfo.jobId || '…' }), {
        pulse: true,
        eyebrow: t('popup.currentPage')
      });
      break;

    case 'checking':
      setStatus('warning', t('popup.queryingLRR'), t('popup.queryingLRRHint'), {
        pulse: true,
        eyebrow: t('popup.currentPage')
      });
      break;

    case 'error':
      setStatus('danger', t('popup.cannotReadDownloadStatus'), tabInfo.message || t('popup.unknownError'), {
        pulse: false,
        eyebrow: t('popup.currentPage')
      });
      break;

    case 'other':
      setStatus('neutral', t('popup.pageNotDownloaded'), t('popup.canTryDownload'), {
        pulse: false,
        eyebrow: t('popup.currentPage')
      });
      break;

    default:
      setStatus('neutral', t('popup.pageStatusUnknown'), t('popup.clickRecheck'), {
        pulse: false,
        eyebrow: t('popup.currentPage')
      });
  }
}

function setStatus(tone, title, detail, options = {}) {
  const tones = {
    neutral: { glyph: '·', pulse: false },
    success: { glyph: '✓', pulse: false },
    running: { glyph: '↓', pulse: true },
    warning: { glyph: '…', pulse: true },
    danger: { glyph: '!', pulse: false }
  };
  const config = tones[tone] || tones.neutral;

  refs.statusCard.dataset.tone = tone;
  refs.statusCard.dataset.pulse = String(Boolean(options.pulse ?? config.pulse));
  refs.statusGlyph.textContent = config.glyph;
  refs.statusEyebrow.textContent = options.eyebrow || t('popup.currentPage');
  refs.statusTitle.textContent = title;
  refs.statusDetail.textContent = detail || '';
}

function appendArchiveLink(arcId, server) {
  if (!arcId || !server) return;
  refs.statusDetail.append(document.createTextNode(' · '));
  const link = document.createElement('a');
  link.href = `${server}/reader?id=${encodeURIComponent(arcId)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = t('popup.openArchive');
  refs.statusDetail.append(link);
}

async function runDownloadAction(mode) {
  if (actionInFlight || !activeTab) return;

  actionInFlight = true;
  document.body.classList.add('is-busy');
  const startedAt = Date.now();
  showLaunchAnimation(mode);

  try {
    const response = await sendMessage({
      type: 'startDownload',
      mode,
      tab: activeTab
    }, 60000);
    await waitForMinimum(startedAt, 900);

    if (!response.ok) throw new Error(response.error || t('popup.downloadNotStarted'));

    setLaunchResult(true, mode);
    await refreshState();
    overlayHideTimer = setTimeout(hideLaunchAnimation, 1350);
  } catch (error) {
    await waitForMinimum(startedAt, 900);
    setLaunchError(error.message || String(error));
    overlayHideTimer = setTimeout(hideLaunchAnimation, 1900);
  } finally {
    actionInFlight = false;
    document.body.classList.remove('is-busy');
  }
}

async function runBatchDownload(direction) {
  if (actionInFlight) return;

  const tabs = await queryWindowTabs();
  const batch = direction === 'left' ? getLeftSideTabs(tabs) : getRightSideTabs(tabs);
  if (batch.length === 0) {
    showToast(direction === 'left' ? t('popup.noTabsLeft') : t('popup.noTabsRight'));
    return;
  }

  actionInFlight = true;
  document.body.classList.add('is-busy');
  const startedAt = Date.now();
  showLaunchAnimation('batch');

  try {
    const response = await sendMessage({ type: 'batchDownload', tabs: batch }, 120000);
    await waitForMinimum(startedAt, 900);
    if (!response.ok) throw new Error(response.error || t('popup.batchNotStarted'));

    setLaunchResult(true, 'batch', response.count);
    await refreshState();
    overlayHideTimer = setTimeout(hideLaunchAnimation, 1350);
  } catch (error) {
    await waitForMinimum(startedAt, 900);
    setLaunchError(error.message || String(error));
    overlayHideTimer = setTimeout(hideLaunchAnimation, 1900);
  } finally {
    actionInFlight = false;
    document.body.classList.remove('is-busy');
  }
}

function showLaunchAnimation(mode) {
  clearTimeout(overlayHideTimer);
  refs.launchOverlay.classList.remove('hidden', 'is-leaving', 'is-success', 'is-error');
  refs.launchOverlay.classList.add('is-launching');
  refs.launchTitle.textContent = mode === 'batch' ? t('popup.launchBatch') : t('popup.launch');
  refs.launchDetail.textContent = mode === 'qb'
    ? t('popup.connectingQB')
    : t('popup.connectingLRR');
  setLaunchIcon('arrow');
  void refs.launchOverlay.offsetWidth;
}

function setLaunchResult(success, mode, count) {
  refs.launchOverlay.classList.remove('is-launching', 'is-error');
  refs.launchOverlay.classList.add('is-success');
  refs.launchTitle.textContent = success ? t('popup.started') : t('popup.cannotStart');

  if (mode === 'batch') {
    refs.launchDetail.textContent = t('popup.batchStartedDetail', { count: count || 0 });
  } else if (mode === 'qb') {
    refs.launchDetail.textContent = t('popup.qbStartedDetail');
  } else {
    refs.launchDetail.textContent = t('popup.lrrStartedDetail');
  }

  setLaunchIcon('check');
}

function setLaunchError(message) {
  refs.launchOverlay.classList.remove('is-launching', 'is-success');
  refs.launchOverlay.classList.add('is-error');
  refs.launchTitle.textContent = t('popup.launchFailed');
  refs.launchDetail.textContent = message;
  setLaunchIcon('close');
}

function setLaunchIcon(type) {
  const paths = {
    arrow: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M6 19h12" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  refs.launchVisual.querySelector('.launch-core').innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[type]}</svg>`;
}

function hideLaunchAnimation() {
  clearTimeout(overlayHideTimer);
  refs.launchOverlay.classList.add('is-leaving');
  setTimeout(() => {
    refs.launchOverlay.classList.add('hidden');
    refs.launchOverlay.classList.remove('is-leaving', 'is-success', 'is-error', 'is-launching');
  }, 190);
}

function queryWindowTabs() {
  return new Promise((resolve) => chrome.tabs.query({ currentWindow: true }, resolve));
}

function getLeftSideTabs(tabs) {
  const activeIndex = tabs.findIndex((tab) => tab.active);
  return tabs.filter((tab) => tab.index < activeIndex);
}

function getRightSideTabs(tabs) {
  const activeIndex = tabs.findIndex((tab) => tab.active);
  return tabs.filter((tab) => tab.index > activeIndex);
}

function formatQBBytes(qb, progress) {
  if (!qb.size) return t('popup.waitingTorrentSize');
  const downloaded = Number(qb.downloadedBytes || (qb.size * progress / 100));
  return `${formatBytes(downloaded)} / ${formatBytes(qb.size)}`;
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
  if (!Number.isFinite(value) || value <= 0 || value >= 8640000) return t('common.unknownTime');
  if (value < 60) return `~${t('common.seconds', { count: Math.ceil(value) })}`;
  if (value < 3600) return `~${t('common.minutes', { count: Math.ceil(value / 60) })}`;
  return `~${t('common.hours', { count: (value / 3600).toFixed(1) })}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
}

function waitForMinimum(startedAt, duration) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, duration - (Date.now() - startedAt))));
}

function showToast(message) {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => refs.toast.classList.remove('is-visible'), 2600);
}

function openDownloadCenter() {
  chrome.tabs.create({ url: chrome.runtime.getURL('downloads.html') });
}

function openLanraragiJobs() {
  const server = currentState?.settings?.server;
  if (!server) {
    showToast(t('popup.lrrNotConfigured'));
    chrome.runtime.openOptionsPage();
    return;
  }
  chrome.tabs.create({ url: `${server}/minion/jobs` });
}

refs.downloadUrl.addEventListener('click', () => runDownloadAction('lrr'));
refs.downloadToQB.addEventListener('click', () => runDownloadAction('qb'));
refs.batchLeft.addEventListener('click', () => runBatchDownload('left'));
refs.batchRight.addEventListener('click', () => runBatchDownload('right'));
refs.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
refs.openDownloads.addEventListener('click', openDownloadCenter);
refs.openDownloadCenter.addEventListener('click', openDownloadCenter);
document.getElementById('viewQBTask').addEventListener('click', openDownloadCenter);
refs.allDownloads.addEventListener('click', openLanraragiJobs);
refs.recheckTab.addEventListener('click', async () => {
  if (!activeTab) return;
  setStatus('warning', t('popup.rechecking'), t('popup.recheckingDetail'), { pulse: true });
  try {
    const state = await sendMessage({ type: 'recheckTab', tab: activeTab }, 30000);
    currentState = state;
    renderState(state);
  } catch (error) {
    setStatus('danger', t('popup.recheckFailed'), error.message || String(error));
  }
});
