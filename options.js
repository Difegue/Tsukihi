// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

function getAuthHeader(apiKey) {
  return { Authorization: "Bearer " + btoa(apiKey) };
}

function updateSettings() {

  let server = document.getElementById('server');
  let key = document.getElementById('key');
  let catid = document.getElementById('catid');

  let status = document.getElementById('statusMsg');

  chrome.storage.sync.set({
    server: server.value,
    api: key.value,
    categoryID: catid.value
  }, function () {
    status.textContent = "👌 Saved!"
  });

}

function checkServer() {

  let server = document.getElementById('server');
  let key = document.getElementById('key');

  let serverInfo = "";
  let apiCheck = "";

  // Test base server connectivity
  fetch(`${server.value}/api/info`, { method: "GET", headers: getAuthHeader(key.value) })
    .then(response => response.ok ? response.json() : { error: "Server didn't reply." })
    .then((data) => {

      if (data.error)
        throw new Error(data.error);

      serverInfo = `✅ "${data.name}", Version ${data.version}.`;
    })
    .catch(error => { serverInfo = `❌ ${error}` })
    .finally(() => document.getElementById('serverMsg').textContent = serverInfo);

  // Test authenticated endpoint
  fetch(`${server.value}/api/plugins/test`, { method: "GET", headers: getAuthHeader(key.value) })
    .then(response => response.ok ? response.json() : { error: "API Key seems to be invalid!" })
    .then((data) => {

      if (data.error)
        throw new Error(data.error);

      apiCheck = `✅ API Key is valid.`;
    })
    .catch(error => { apiCheck = `🛑 ${error}` })
    .finally(() => document.getElementById('apiCheck').textContent = apiCheck);
}

let button = document.getElementById('saveBtn');
button.addEventListener('click', updateSettings);

button = document.getElementById('checkBtn');
button.addEventListener('click', checkServer);

// Prefill fields with settings
chrome.storage.sync.get(['server', 'api', 'categoryID'], function (result) {
  document.getElementById('server').value = result.server ?? "";
  document.getElementById('key').value = result.api ?? "";
  document.getElementById('catid').value = result.categoryID ?? "";

  checkServer();
});

document.getElementById('versionInfo').textContent = chrome.runtime.getManifest().version;


