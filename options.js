// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

let supportedUrls = [];
let settingsLoaded = false;
let toastTimer = null;
let currentLanguage = TSUKIHI_DEFAULT_LANGUAGE;

const refs = {
  form: document.getElementById('settingsForm'),
  server: document.getElementById('server'),
  key: document.getElementById('key'),
  category: document.getElementById('category'),
  catid: document.getElementById('catid'),
  closeOnDL: document.getElementById('closeOnDL'),
  enableQB: document.getElementById('enableQB'),
  qbServer: document.getElementById('qbServer'),
  qbApiKey: document.getElementById('qbApiKey'),
  qbUsername: document.getElementById('qbUsername'),
  qbPassword: document.getElementById('qbPassword'),
  qbPath: document.getElementById('qbPath'),
  serverMsg: document.getElementById('serverMsg'),
  apiCheck: document.getElementById('apiCheck'),
  categoryErr: document.getElementById('categoryErr'),
  qbStatusMsg: document.getElementById('qbStatusMsg'),
  serverDot: document.getElementById('serverDot'),
  qbDot: document.getElementById('qbDot'),
  statusMsg: document.getElementById('statusMsg'),
  urlRegexes: document.getElementById('urlRegexes'),
  shortcutList: document.getElementById('shortcutList'),
  languageSelect: document.getElementById('languageSelect'),
  toast: document.getElementById('toast')
};

initialize();

async function initialize() {
  document.getElementById('versionInfo').textContent = chrome.runtime.getManifest().version;
  currentLanguage = await tsukihiGetLanguage();
  refs.languageSelect.value = currentLanguage;
  tsukihiApplyPageTranslations(currentLanguage);
  tsukihiBindLanguageSelect(refs.languageSelect, async (language) => {
    await applyLanguage(language);
  });
  tsukihiWatchLanguage((language) => {
    if (language === currentLanguage) return;
    applyLanguage(language);
  });

  refs.form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettings();
  });
  refs.form.addEventListener('input', markDirty);
  refs.form.addEventListener('change', markDirty);
  document.getElementById('checkBtn').addEventListener('click', checkServer);
  document.getElementById('checkQBBtn').addEventListener('click', checkQBConnection);
  refs.category.addEventListener('change', updateCategoryDetails);
  document.getElementById('openDownloadCenter').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('downloads.html') });
  });

  await loadSettings();
  await loadShortcuts();
}

function t(key, variables = {}) {
  return tsukihiTranslate(currentLanguage, key, variables);
}

async function applyLanguage(language) {
  currentLanguage = language;
  refs.languageSelect.value = language;
  tsukihiApplyPageTranslations(language);
  await loadShortcuts();
  if (!settingsLoaded) return;

  if (refs.server.value.trim()) {
    checkServer({ automatic: true });
  } else {
    setConnectionState('server', 'neutral');
    setInlineStatus(refs.serverMsg, t('options.waitingServer'), '');
    setInlineStatus(refs.apiCheck, '', '');
    refs.categoryErr.textContent = t('options.categoryHint');
    refs.categoryErr.dataset.tone = '';
  }

  if (refs.qbServer.value.trim() && (refs.qbApiKey.value || refs.qbUsername.value || refs.qbPassword.value)) {
    checkQBConnection({ automatic: true });
  } else {
    setConnectionState('qb', 'neutral');
    setInlineStatus(refs.qbStatusMsg, t('options.waitingAuth'), '');
  }
}

async function loadSettings() {
  const result = await storageSyncGet([
    'server',
    'api',
    'categoryID',
    'supportedURLs',
    'closeOnDL',
    'enableQB',
    'qbServer',
    'qbApiKey',
    'qbUsername',
    'qbPassword',
    'qbPath'
  ]);

  refs.server.value = result.server || '';
  refs.key.value = result.api || '';
  refs.catid.value = result.categoryID || '';
  refs.closeOnDL.checked = Boolean(result.closeOnDL);
  refs.enableQB.checked = result.enableQB !== false;
  refs.qbServer.value = result.qbServer || '';
  refs.qbApiKey.value = result.qbApiKey || '';
  refs.qbUsername.value = result.qbUsername || 'admin';
  refs.qbPassword.value = result.qbPassword || '';
  refs.qbPath.value = result.qbPath || '';
  supportedUrls = Array.isArray(result.supportedURLs) ? result.supportedURLs : [];
  refs.urlRegexes.textContent = supportedUrls.length
    ? supportedUrls.join('\n')
    : t('options.loadAfterConnect');

  settingsLoaded = true;
  refs.statusMsg.textContent = t('options.saveLoaded');

  if (refs.server.value.trim()) {
    checkServer({ automatic: true });
  } else {
    setConnectionState('server', 'neutral');
    setInlineStatus(refs.serverMsg, t('options.waitingServer'), '');
  }

  if (refs.qbServer.value.trim() && (refs.qbApiKey.value || refs.qbUsername.value || refs.qbPassword.value)) {
    checkQBConnection({ automatic: true });
  } else {
    setConnectionState('qb', 'neutral');
    setInlineStatus(refs.qbStatusMsg, t('options.waitingAuth'), '');
  }
}

async function saveSettings() {
  refs.statusMsg.textContent = t('options.saving');

  try {
    await storageSyncSet({
      server: refs.server.value.trim().replace(/\/+$/, ''),
      api: refs.key.value,
      categoryID: refs.category.value || refs.catid.value || '',
      supportedURLs: supportedUrls,
      closeOnDL: refs.closeOnDL.checked,
      enableQB: refs.enableQB.checked,
      qbServer: refs.qbServer.value.trim().replace(/\/+$/, ''),
      qbApiKey: refs.qbApiKey.value.trim(),
      qbUsername: refs.qbUsername.value.trim(),
      qbPassword: refs.qbPassword.value,
      qbPath: refs.qbPath.value.trim()
    });

    refs.catid.value = refs.category.value || refs.catid.value || '';
    refs.statusMsg.textContent = t('options.savedAt', { time: new Date().toLocaleTimeString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }) });
    showToast(t('options.savedToast'));
  } catch (error) {
    refs.statusMsg.textContent = t('options.saveFailed', { error: error.message || error });
  }
}

async function checkServer(options = {}) {
  const server = refs.server.value.trim().replace(/\/+$/, '');
  const apiKey = refs.key.value;
  const selectedID = refs.catid.value || refs.category.value;

  if (!server) {
    setConnectionState('server', 'neutral');
    setInlineStatus(refs.serverMsg, t('options.lrrNoServer'), 'danger');
    return;
  }

  setConnectionState('server', 'checking');
  setInlineStatus(refs.serverMsg, options.automatic ? t('options.checkingAuto') : t('options.checking'), '');
  setInlineStatus(refs.apiCheck, t('options.validatingKey'), '');
  refs.categoryErr.textContent = t('options.readingCategories');
  refs.categoryErr.dataset.tone = '';

  try {
    const headers = getAuthHeader(apiKey);
    const [info, plugins, categories] = await Promise.all([
      fetchJson(`${server}/api/info`, { headers }),
      fetchJson(`${server}/api/plugins/download`, { headers }),
      fetchJson(`${server}/api/categories`, { headers })
    ]);

    if (!Array.isArray(plugins) || !Array.isArray(categories)) {
      throw new Error(t('options.incompatibleData'));
    }

    setConnectionState('server', 'success');
    setInlineStatus(refs.serverMsg, t('options.connected', { name: info.name || 'LANraragi', version: info.version || t('common.unknown') }), 'success');
    setInlineStatus(refs.apiCheck, t('options.apiValid'), 'success');

    supportedUrls = plugins.map((plugin) => plugin.url_regex).filter(Boolean);
    refs.urlRegexes.textContent = supportedUrls.length
      ? supportedUrls.join('\n')
      : t('options.noUrlRules');

    populateCategories(categories, selectedID);
    refs.categoryErr.textContent = t('options.categoriesLoaded', { count: categories.filter((category) => category.search === '').length });
    refs.categoryErr.dataset.tone = 'success';
  } catch (error) {
    setConnectionState('server', 'danger');
    setInlineStatus(refs.serverMsg, t('options.connectionFailed', { error: error.message || error }), 'danger');
    setInlineStatus(refs.apiCheck, t('options.connectionHelp'), 'danger');
    refs.categoryErr.textContent = t('options.categoryLoadFailed');
    refs.categoryErr.dataset.tone = 'danger';
  }
}

function populateCategories(categories, selectedID) {
  refs.category.options.length = 0;
  refs.category.options[0] = new Option(t('options.noCategory'), '', true, false);

  for (const category of categories) {
    if (category.search !== '') continue;
    refs.category.options[refs.category.options.length] = new Option(
      category.name,
      category.id,
      false,
      category.id === selectedID
    );
  }

  const selectedOption = Array.from(refs.category.options).find((option) => option.value === selectedID);
  if (selectedOption) refs.category.value = selectedID;
  refs.catid.value = refs.category.value;
}

async function checkQBConnection(options = {}) {
  const settings = {
    qbServer: refs.qbServer.value.trim().replace(/\/+$/, ''),
    qbApiKey: refs.qbApiKey.value.trim(),
    qbUsername: refs.qbUsername.value.trim(),
    qbPassword: refs.qbPassword.value
  };

  if (!settings.qbServer) {
    setConnectionState('qb', 'neutral');
    setInlineStatus(refs.qbStatusMsg, t('options.enterQBFirst'), 'danger');
    return;
  }
  if (!settings.qbApiKey && !settings.qbUsername && !settings.qbPassword) {
    setConnectionState('qb', 'neutral');
    setInlineStatus(refs.qbStatusMsg, t('options.enterAuth'), 'danger');
    return;
  }

  setConnectionState('qb', 'checking');
  setInlineStatus(refs.qbStatusMsg, options.automatic ? t('options.testingQBAuto') : t('options.testingQB'), '');

  try {
    const result = await sendMessage({ type: 'testQBConnection', settings });
    if (!result.ok) throw new Error(result.error || t('options.qbConnectionFailed'));

    setConnectionState('qb', 'success');
    const method = result.authMode === 'api-key' ? t('options.apiKeyMethod') : t('options.passwordMethod');
    setInlineStatus(
      refs.qbStatusMsg,
      t('options.qbConnected', { method, version: result.version }) + (result.apiVersion ? ` · API ${result.apiVersion}` : ''),
      'success'
    );
  } catch (error) {
    setConnectionState('qb', 'danger');
    setInlineStatus(refs.qbStatusMsg, t('options.connectionFailed', { error: error.message || error }), 'danger');
  }
}

function updateCategoryDetails() {
  refs.catid.value = refs.category.value;
}

function markDirty() {
  if (!settingsLoaded) return;
  refs.statusMsg.textContent = t('options.settingsDirty');
}

function setConnectionState(engine, tone) {
  const dot = engine === 'qb' ? refs.qbDot : refs.serverDot;
  dot.dataset.tone = tone;
}

function setInlineStatus(element, message, tone) {
  element.textContent = message;
  element.dataset.tone = tone || '';
}

async function loadShortcuts() {
  try {
    const commands = await chromeCommandsGetAll();
    const labels = {
      'download-current-tab': t('options.shortcutDirect'),
      'download-current-tab-qb': t('options.shortcutQB'),
      'open-download-center': t('options.shortcutCenter')
    };

    const rows = commands
      .filter((command) => labels[command.name])
      .map((command) => ({ label: labels[command.name], shortcut: command.shortcut || t('options.notSet') }));

    if (rows.length === 0) return;
    refs.shortcutList.replaceChildren();
    for (const row of rows) {
      const container = document.createElement('div');
      container.className = 'shortcut-row';

      const label = document.createElement('span');
      label.textContent = row.label;

      const key = document.createElement('kbd');
      key.textContent = row.shortcut;

      container.append(label, key);
      refs.shortcutList.append(container);
    }
  } catch (error) {
    console.warn('Could not load keyboard shortcuts:', error);
  }
}

function getAuthHeader(apiKey) {
  return { Authorization: `Bearer ${btoa(apiKey || '')}` };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(t('options.invalidJson', { status: response.status }));
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
  }

  return data;
}

function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      settled = true;
      reject(new Error(t('options.backgroundTimeout', { seconds: Math.round(timeoutMs / 1000) })));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response) reject(new Error(t('options.backgroundNoResponse')));
        else resolve(response);
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

function chromeCommandsGetAll() {
  return new Promise((resolve) => {
    chrome.commands.getAll((commands) => resolve(commands || []));
  });
}

function storageSyncGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSyncSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => refs.toast.classList.remove('is-visible'), 2600);
}
