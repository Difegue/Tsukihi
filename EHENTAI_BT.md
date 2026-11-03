# E-Hentai qBittorrent Downloads

## Overview

For `e-hentai.org` and `exhentai.org` gallery pages, Tsukihi parses the available E-Hentai torrent list, sends the current torrent to qBittorrent, and tracks the result in the dedicated download center.

Direct LANraragi downloads remain a separate action and are never mixed with qBittorrent downloads.

## qBittorrent Configuration

1. Open the **qBittorrent** card on the extension's settings page.
2. Enter the qBittorrent WebUI URL, for example `http://192.168.1.10:8080`.
3. Enter a current qBittorrent API Key. New API Keys normally start with `qbt_`.
4. Click **Test qBittorrent**.
5. Optionally enter a download save path, then save the settings.

### API Key Behavior

- Current qBittorrent API Keys are sent with the `Authorization: Bearer <key>` header.
- If Bearer authentication returns `401` or `403`, the extension retries with `X-API-Key`.
- When an API Key is configured, the extension does not call `/api/v2/auth/login`. This avoids conflicts between API Key authentication and the legacy login flow.
- Older qBittorrent versions without API Key support can leave the API Key empty and use username/password login instead.

## Usage

1. Open an E-Hentai or ExHentai gallery page.
2. Open the extension popup and choose **Send to qBittorrent**, or use the context menu / `Alt+Shift+Q`.
3. Tsukihi reports the following stages:
   - Parsing the E-Hentai torrent list
   - Sending the torrent to qBittorrent
   - qBittorrent is acquiring the torrent
   - qBittorrent has acquired the torrent
   - File download progress, speed, and ETA
   - Download complete
4. Open the **Download center** to view the separate qBittorrent progress bar and per-file progress.

## Torrent Add Responses

Tsukihi supports the add response formats used by different qBittorrent versions:

- Newer JSON responses: `success_count`, `failure_count`, `pending_count`, and `added_torrent_ids`
- Legacy text responses: `Ok.` and `Fails.`

If qBittorrent reports that adding the torrent failed but a torrent with the same title already exists, Tsukihi continues tracking the existing torrent instead of reporting a false failure or creating an unnecessary duplicate task.

## Download Separation and Fallback Behavior

- **Direct download to LANraragi**: Always sends the current URL directly to LANraragi.
- **Send to qBittorrent**: Only handles E-Hentai / ExHentai galleries and never silently falls back to LANraragi.
- Both workflows are recorded in the download center, including clear failure details when a task cannot be completed.
