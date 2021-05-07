// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

let tabHashmap = new Map();

/**
 * Setup on extension init.
 */

chrome.runtime.onInstalled.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url) {
    tabHashmap.delete(tabId);
    onNewUrl(tab);
  } else if (changeInfo.status && tabHashmap.has(tabId)) {
    // Per-tab badges go away when the tab is refreshed, so we put 'em back
    updateBadge(tab, tabHashmap.get(tabId));
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function (tab) {
    onNewUrl(tab);
  });
});

chrome.runtime.onMessage.addListener(
  function (request, sender, callback) {

    // Multi-tab download req
    if (request.type == "batchDownload") {
      chrome.storage.sync.get(['server', 'api', 'categoryID'], function (result) {

        request.tabs?.forEach(tab => {
          sendDownloadRequest(tab, result.server, result.api, result.categoryID);
        });

      });
    }

    // Single tab download req
    if (request.type == "downloadUrl") {
      chrome.storage.sync.get(['server', 'api', 'categoryID'], function (result) {
        sendDownloadRequest(request.tab, result.server, result.api, result.categoryID);
      });
    }

    // Tab info req
    if (request.type == "getTabInfo") {
      callback(tabHashmap.get(request.tab.id));
    }

    // Reverify tab req
    if (request.type == "recheckTab") {
      tabHashmap.delete(request.tab.id);
      onNewUrl(request.tab, true);
    }

  });


function onNewUrl(tab, bypassRegexes = false) {
  // If the tab already has a browserAction, we do nothing
  if (!tabHashmap.has(tab.id))
    chrome.storage.sync.get(['server', 'api', 'supportedURLs'], function (result) {
      if (typeof result.server !== 'undefined' && result.server.trim() !== "") // check for undefined
        if (bypassRegexes || isUrlSupported(tab, result.supportedURLs))
          checkUrl(result.server.trim(), result.api, tab);
        else
          updateTabInfo(tab, { status: "other", message: "This website is not supported for downloading. But you can still try it!" });
      else
        updateTabInfo(tab, { status: "other", message: "Please setup your server settings." });
    });
}

function isUrlSupported(tab, urlRegexes) {
  
  if (typeof urlRegexes === 'undefined' || tab.url === undefined) return false;

  urlRegexes = urlRegexes.map(s => new RegExp(s));
  let checks = urlRegexes.map(regex => regex.test(tab.url));

  return (checks.includes(true));
}

/**
 * Send a call to the source finder to check if the given URL is already downloaded or not.
 * Updates the badge with the results
 * @param {*} serverUrl URL to LRR server 
 * @param {*} apiKey API Key for LRR server
 * @param {*} url URL to check
 */
function checkUrl(serverUrl, apiKey, tab) {

  updateTabInfo(tab, { status: "checking" });

  if (tab.url === undefined) {
    updateTabInfo(tab, { status: "other", message: "Not a downloadable URL. " });
    return;
  }

  // The urlfinder plugin can handle the url as is.
  console.log(`${serverUrl}/api/plugins/use?plugin=urlfinder&arg=${tab.url}`);

  fetch(`${serverUrl}/api/plugins/use?plugin=urlfinder&arg=${tab.url}`,
    { method: "POST", headers: getAuthHeader(apiKey) })
    .then(response => response.json())
    .then((r) => {
      if (r.success === 1) {
        updateTabInfo(tab, { status: "downloaded", arcId: r.data.id });
      } else {
        updateTabInfo(tab, { status: "other", message: r.error });
      }
    })
    .catch(error => {
      updateTabInfo(tab, { status: "error", message: error.toString() });
      // Turn this on for debug notifications
      //showNotification("Error while checking URL :", error.toString());
    });

}

/**
 * Update the tab's browserAction, and update data in popup and hashmap.
 * @param {*} tab Tab to update
 * @param {*} infoObject Info object, should contain at least the "status" element.
 */
function updateTabInfo(tab, infoObject) {

  chrome.tabs.get(tab.id, function () {

    if (chrome.runtime.lastError) {

      // Tab has likely been closed
      console.log(chrome.runtime.lastError.message);
      tabHashmap.delete(tab.id);
    } else {

      // Tab exists
      updateBadge(tab, infoObject);

      // Save info in hashmap, and send it to the popup if it's open
      tabHashmap.set(tab.id, infoObject);
      if (tab.active)
        chrome.runtime.sendMessage({ type: "updateFromBackground", data: infoObject });
    }
  });
}

function updateBadge(tab, info) {

  let color = "rgb(194, 25, 25)";
  let text = "???";

  try {
    console.log(tab.id + " " + JSON.stringify(info));
    switch (info.status) {
      case "downloaded":
        text = "✔";
        color = "rgb(25, 194, 48)";
        break;
      case "downloading":
        text = "#" + info.jobId;
        color = "rgb(64, 124, 255)";
        break;
      case "checking":
        text = "...";
        color = "rgb(255, 174, 0)";
        break;
      case "error":
        text = "ERR";
        color = "rgb(194, 25, 25)";
        break;
      case "other":
        text = "X";
        color = "rgb(54, 57, 64)";
        break;
    }
  } catch (e) { console.log(e); }

  console.log(color + text);
  chrome.browserAction.setBadgeBackgroundColor({ color: color, tabId: tab.id });
  chrome.browserAction.setBadgeText({ text: text, tabId: tab.id });
}

// Send URLs to the Download API and add a checkJobStatus to track its progress.
function sendDownloadRequest(tab, serverUrl, apiKey, categoryID) {

  if (tab.url === undefined) {
    updateTabInfo(tab, { status: "other", message: "Not a downloadable URL. " });
    return;
  }

  let formData = new FormData();
  formData.append('url', tab.url);

  if (categoryID !== "") {
    formData.append('catid', categoryID);
  }

  fetch(`${serverUrl}/api/download_url`, { method: "POST", body: formData, headers: getAuthHeader(apiKey) })
    .then(response => response.json())
    .then((data) => {
      if (data.success) {

        updateTabInfo(tab, { status: "downloading", jobId: data.job });
        showNotification(`Download for ${tab.url}`, `Queued as job #${data.job}!`);

        // Check minion job state periodically to update the result 
        checkJobStatus(serverUrl, apiKey, data.job,
          (d) => handleDownloadResult(tab, d.result),
          (error) => console.log(error));
      } else {
        throw new Error(data.message);
      }
    })
    .catch(error => showNotification("Error while queuing your Download", error.toString()));
}

function handleDownloadResult(tab, data) {

  if (data.success === 1) {
    updateTabInfo(tab, { status: "downloaded", arcId: data.id });
    showNotification(`Download of ${tab.url} complete!`, 
      `File has been saved to your server and given the ID ${data.id}`);
  } else {
    updateTabInfo(tab, { status: "error", message: data.message });
    showNotification(`Download for ${tab.url}`, `Failed: ${data.message}`);
  }
}

function getAuthHeader(apiKey) {
  return { Authorization: "Bearer " + btoa(apiKey) };
}

function showNotification(title, msg) {

  var opt = {
    type: "basic",
    title: title,
    message: (typeof msg === 'string' || msg instanceof String) ? msg : JSON.stringify(msg),
    iconUrl: "images/get_started128.png"
  }

  console.log(title + " " + msg);
  chrome.notifications?.create(null, opt, null);
}

/**
* Checks the status of a Download job until it's completed.
* Execute a callback on successful job completion.
* @param {*} serverUrl 
* @param {*} apiKey 
* @param {*} jobId 
* @param {*} callback 
* @param {*} failureCallback 
*/
function checkJobStatus(serverUrl, apiKey, jobId, callback, failureCallback) {

  fetch(`${serverUrl}/api/minion/${jobId}`, { method: "GET", headers: getAuthHeader(apiKey) })
    .then(response => response.ok ? response.json() : { success: 0, error: "Response was not OK" })
    .then((data) => {

      if (data.error)
        throw new Error(data.error);

      if (data.state === "failed") {
        throw new Error(data.result);
      }

      if (data.state !== "finished") {
        // Wait and retry, job isn't done yet
        setTimeout(function () {
          checkJobStatus(serverUrl, apiKey, jobId, callback, failureCallback);
        }, 2000);
      } else {
        // Update UI with info
        callback(data);
      }
    })
    .catch(error => { showNotification("URL Download Failed", error.toString()); failureCallback(error) });
}