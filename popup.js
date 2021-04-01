// Use of this source code is governed by a license that can be
// found in the LICENSE file.

'use strict';

// Ask background.js about the state of this tab, and update popup accordingly.
chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  chrome.runtime.sendMessage({ type: "getTabInfo", tab: tabs[0] }, (response) => updatePopup(response));
});

// Add a listener to receive dynamic updates from background.js
chrome.runtime.onMessage.addListener(
  function (request, sender, callback) {

    if (request.type == "updateFromBackground") {
      updatePopup(request.data);
    }

  }
);

// Hook up buttons
document.getElementById('downloadUrl').onclick = function (element) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.runtime.sendMessage({ type: "downloadUrl", tab: tabs[0] });
  });
};

document.getElementById('openSettings').onclick = function (element) {
  chrome.runtime.openOptionsPage()
};

document.getElementById('recheckTab').onclick = function (element) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.runtime.sendMessage({ type: "recheckTab", tab: tabs[0] });
  });
};

// Wow actual logic
function updatePopup(dataFromBackground) {

  console.log("Received data from background.js: " + JSON.stringify(dataFromBackground));
  document.getElementById('statusMsg').style = "color:black"

  switch (dataFromBackground.status) {
    case "downloaded":
      document.getElementById('statusIcon').textContent = "✅";
      document.getElementById('statusMsg').textContent = " saved to your LRR server!";
      document.getElementById('statusMsg').style = "color:green"
      document.getElementById('statusDetail').textContent = `(id: ${dataFromBackground.arcId})`;
      break;
    case "downloading":
      document.getElementById('statusIcon').textContent = "🔜";
      document.getElementById('statusMsg').textContent = " being downloaded...";
      document.getElementById('statusMsg').style = "color:blue"
      document.getElementById('statusDetail').textContent = `(job: #${dataFromBackground.jobId})`;
      break;
    case "checking":
      document.getElementById('statusIcon').textContent = "⌛";
      document.getElementById('statusMsg').textContent = " being checked...";
      document.getElementById('statusMsg').style = "color:orange"
      document.getElementById('statusDetail').textContent = `(Please wait warmly.)`;
      break;
    case "other":
      document.getElementById('statusIcon').textContent = "⁉";
      document.getElementById('statusMsg').textContent = "... just a tab.";
      document.getElementById('statusDetail').textContent = `(${dataFromBackground.message})`;
      break;
    default:
      document.getElementById('statusIcon').textContent = "❌";
      document.getElementById('statusMsg').textContent = " we just don't know.";
      document.getElementById('statusDetail').textContent = `(Unknown status message ${dataFromBackground.status})`;
  }
}