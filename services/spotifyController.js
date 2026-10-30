"use strict";

/**
 * Spotify Web Controller
 * ---------------------------------------------------------
 * Mengontrol Spotify Web Player yang sudah terbuka di Brave
 * melalui Chrome DevTools Protocol (CDP).
 *
 * Controller ini TIDAK membuka browser baru. Brave harus sudah
 * dijalankan dengan remote debugging aktif (lihat
 * scripts/start-brave-spotify.bat), lalu controller attach ke
 * browser tersebut memakai chromium.connectOverCDP().
 *
 * Desain operasi mengikuti spotify-controls-api:
 *   play(), pause(), playpause(), next(), previous(), current()
 * ditambah kebutuhan Spotify Web:
 *   searchTrack(), playTrack(), searchPlaylist(), playPlaylist(),
 *   getPlaybackStatus()
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

// Muat konfigurasi lokal bila ada. Nilai yang sudah ada di
// environment tidak ditimpa. Tidak ada credential Spotify yang
// dibaca/ditulis di sini.
for (const envFile of [".env", "api.env"]) {
  const envPath = path.join(__dirname, "..", envFile);

  if (fs.existsSync(envPath)) {
    try {
      require("dotenv").config({ path: envPath });
    } catch {}
  }
}

const SPOTIFY_ORIGIN = "https://open.spotify.com";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

const DEFAULTS = {
  connectTimeout: 15000,
  navigationTimeout: 45000,
  elementTimeout: 15000,
  searchTimeout: 20000,
  verifyTimeout: 20000,
  transitionTimeout: 10000,
  pollInterval: 250
};

const CONTROL = {
  playPause: '[data-testid="control-button-playpause"]',
  next: '[data-testid="control-button-skip-forward"]',
  previous: '[data-testid="control-button-skip-back"]'
};

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]"
]);

class SpotifyError extends Error {
  constructor(message, code = "SPOTIFY_ERROR", details = null) {
    super(message);
    this.name = "SpotifyError";
    this.code = code;
    this.details = details;
  }
}

function log(...args) {
  console.log("[SPOTIFY]", ...args);
}

function warn(...args) {
  console.warn("[SPOTIFY]", ...args);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatSeconds(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;

  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Skor kemiripan 0..1. Cukup toleran untuk perbedaan kecil antara
 * query dan judul hasil Spotify, tetapi tetap membedakan lagu lain.
 */
function textSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);

    return 0.5 + 0.5 * (shorter / longer);
  }

  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));

  let intersection = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  if (!intersection) {
    return 0;
  }

  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function bestArtistSimilarity(requestedArtist, artistNames) {
  if (!requestedArtist) {
    return 0;
  }

  const names = Array.isArray(artistNames) ? artistNames : [artistNames];

  return names.reduce(
    (best, artist) => Math.max(best, textSimilarity(requestedArtist, artist)),
    0
  );
}

function parseTrackQuery(input) {
  const raw = String(input || "").trim();
  const match = raw.match(/^(.*?)\s+artist\s+(.+)$/i);

  if (match && match[1].trim() && match[2].trim()) {
    const title = match[1].trim();
    const artist = match[2].trim();

    return {
      raw,
      title,
      artist,
      searchQuery: `${title} ${artist}`
    };
  }

  return {
    raw,
    title: raw,
    artist: null,
    searchQuery: raw
  };
}

/**
 * Pilih hasil track terbaik. Judul lebih penting daripada artis,
 * tetapi artis yang diminta eksplisit tetap diberi bobot besar.
 */
function selectBestTrack(results, queryInfo) {
  const { title, artist, raw } = queryInfo;

  let best = null;
  let bestScore = -1;

  for (const result of results) {
    const titleScore = textSimilarity(title, result.title);
    const artistScore = bestArtistSimilarity(artist, result.artists);
    const rawScore = textSimilarity(raw, `${result.title} ${result.artists.join(" ")}`);

    let score = titleScore * 2 + rawScore * 0.35;

    if (artist) {
      score += artistScore * 2;
    } else {
      // Jika pengguna mengetik nama artis tanpa kata "artist",
      // beri sedikit bonus pada hasil yang artisnya disebut di query.
      const queryTokens = new Set(tokenize(raw));
      const artistTokens = result.artists.flatMap(tokenize);

      if (artistTokens.length) {
        const mentioned = artistTokens.filter((token) =>
          queryTokens.has(token)
        ).length;

        score += 0.25 * (mentioned / artistTokens.length);
      }
    }

    if (result.hasRow) {
      score += 0.08;
    }

    // Prioritaskan hasil yang benar-benar punya kontrol Play.
    if (result.playLabel) {
      score += 0.05;
    }

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }

  return best ? { ...best, score: bestScore } : null;
}

function selectBestPlaylist(results, query) {
  let best = null;
  let bestScore = -1;

  for (const result of results) {
    const score = textSimilarity(query, result.title);

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }

  return best ? { ...best, score: bestScore } : null;
}

function extractTrackId(href) {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, SPOTIFY_ORIGIN);
    const match = url.pathname.match(/^\/track\/([A-Za-z0-9]+)/);

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function extractPlaylistId(href) {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, SPOTIFY_ORIGIN);
    const match = url.pathname.match(/^\/playlist\/([A-Za-z0-9]+)/);

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function absoluteSpotifyUrl(href) {
  try {
    return new URL(href, SPOTIFY_ORIGIN).toString();
  } catch {
    return null;
  }
}

function isRecoverableError(error) {
  const message = String(error?.message || "");

  return /target page, context or browser has been closed|target closed|browser has been closed|browser has disconnected|websocket.*closed|session closed|protocol error|econnrefused|econnreset|socket hang up/i.test(
    message
  );
}

function probeCdpEndpoint(cdpUrl, timeoutMs) {
  let endpoint;

  try {
    endpoint = new URL(cdpUrl);
  } catch {
    throw new SpotifyError(
      `SPOTIFY_CDP_URL tidak valid: ${cdpUrl}`,
      "CDP_INVALID_URL"
    );
  }

  if (!LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) {
    throw new SpotifyError(
      "SPOTIFY_CDP_URL harus mengarah ke localhost (127.0.0.1). " +
        "Jangan membuka port remote debugging ke jaringan.",
      "CDP_NOT_LOOPBACK"
    );
  }

  const versionUrl = new URL("/json/version", endpoint);
  const client = versionUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(
      versionUrl,
      { timeout: timeoutMs },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 8192) {
            body += chunk;
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new SpotifyError(
                `Endpoint CDP merespons HTTP ${response.statusCode}.`,
                "CDP_UNREACHABLE"
              )
            );
            return;
          }

          try {
            const info = JSON.parse(body);

            resolve({
              browser: info.Browser || "Brave",
              protocolVersion: info["Protocol-Version"] || "unknown"
            });
          } catch {
            reject(
              new SpotifyError(
                "Endpoint CDP tidak mengembalikan JSON yang valid.",
                "CDP_UNREACHABLE"
              )
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new SpotifyError(
          `Koneksi ke CDP timeout (${timeoutMs} ms).`,
          "CDP_TIMEOUT"
        )
      );
    });

    request.on("error", (error) => {
      if (error instanceof SpotifyError) {
        reject(error);
        return;
      }

      reject(
        new SpotifyError(
          `Tidak dapat terhubung ke Brave CDP di ${cdpUrl}. ` +
            "Jalankan scripts\\start-brave-spotify.bat terlebih dahulu.",
          "CDP_UNREACHABLE",
          { cause: error.message }
        )
      );
    });
  });
}

class SpotifyController {
  constructor(options = {}) {
    this.cdpUrl =
      options.cdpUrl || process.env.SPOTIFY_CDP_URL || DEFAULT_CDP_URL;
    this.origin = options.origin || SPOTIFY_ORIGIN;
    this.timeouts = {
      ...DEFAULTS,
      connectTimeout: envNumber(
        "SPOTIFY_CDP_TIMEOUT",
        DEFAULTS.connectTimeout
      ),
      navigationTimeout: envNumber(
        "SPOTIFY_NAVIGATION_TIMEOUT",
        DEFAULTS.navigationTimeout
      ),
      verifyTimeout: envNumber(
        "SPOTIFY_VERIFY_TIMEOUT",
        DEFAULTS.verifyTimeout
      ),
      ...(options.timeouts || {})
    };

    this._connectOverCDP =
      options.connectOverCDP ||
      ((endpoint, connectOptions) =>
        chromium.connectOverCDP(endpoint, connectOptions));

    this._shouldProbe = !options.connectOverCDP;

    this._browser = null;
    this._context = null;
    this._page = null;
    this._connecting = null;
    this._commandQueue = Promise.resolve();
    this._loggedPageDiscovery = false;
  }

  /**
   * Serialisasi seluruh command Spotify. Ini mencegah dua command
   * WhatsApp menavigasi halaman yang sama secara bersamaan.
   */
  enqueue(task) {
    const run = this._commandQueue.then(task, task);

    this._commandQueue = run.catch(() => {});

    return run;
  }

  async connect() {
    if (this._browser && this._browser.isConnected() && this._context) {
      return this._context;
    }

    if (this._connecting) {
      return this._connecting;
    }

    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });

    return this._connecting;
  }

  async _doConnect() {
    this._browser = null;
    this._context = null;
    this._page = null;

    if (this._shouldProbe) {
      const info = await probeCdpEndpoint(
        this.cdpUrl,
        this.timeouts.connectTimeout
      );

      log(`CDP tersedia (${info.browser}, protocol ${info.protocolVersion}).`);
    }

    let browser;

    try {
      browser = await this._connectOverCDP(this.cdpUrl, {
        timeout: this.timeouts.connectTimeout
      });
    } catch (error) {
      throw new SpotifyError(
        `Gagal attach ke Brave melalui CDP di ${this.cdpUrl}. ` +
          "Pastikan Brave dijalankan dengan remote debugging di localhost.",
        "CDP_CONNECT_FAILED",
        { cause: error.message }
      );
    }

    this._browser = browser;

    browser.on("disconnected", () => {
      if (this._browser !== browser) {
        return;
      }

      warn("Koneksi CDP terputus. Koneksi akan dibuat ulang saat command berikutnya.");
      this._browser = null;
      this._context = null;
      this._page = null;
      this._loggedPageDiscovery = false;
    });

    const contexts = browser.contexts();
    const context = contexts[0];

    if (!context) {
      this._browser = null;

      throw new SpotifyError(
        "Brave terhubung, tetapi tidak ada browser context yang bisa dipakai. " +
          "Buka Brave secara normal (bukan mode khusus) lalu coba lagi.",
        "CDP_NO_CONTEXT"
      );
    }

    this._context = context;
    log("Terhubung ke Brave. Browser milik pengguna tidak akan ditutup.");

    return context;
  }

  _attachPage(page) {
    if (this._page === page) {
      return;
    }

    this._page = page;
    page.setDefaultTimeout(this.timeouts.elementTimeout);

    page.once("close", () => {
      if (this._page === page) {
        warn("Tab Spotify ditutup. Tab baru akan dibuat saat command berikutnya.");
        this._page = null;
      }
    });
  }

  async getPage() {
    const context = await this.connect();

    if (this._page && !this._page.isClosed()) {
      return this._page;
    }

    const pages = context.pages();
    const existing = pages.find((page) => {
      if (page.isClosed()) {
        return false;
      }

      const url = page.url();

      return (
        url.startsWith(this.origin) ||
        url.startsWith("https://accounts.spotify.com")
      );
    });

    if (existing) {
      this._attachPage(existing);

      if (!this._loggedPageDiscovery) {
        log("Menggunakan tab Spotify Web yang sudah terbuka.");
        this._loggedPageDiscovery = true;
      }

      return existing;
    }

    log("Tab Spotify Web tidak ditemukan. Membuat tab baru di Brave.");

    const page = await context.newPage();
    this._attachPage(page);

    await this._goto(page, `${this.origin}/`);

    return page;
  }

  async _goto(page, url) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeouts.navigationTimeout
      });
    } catch (error) {
      // Navigasi SPA kadang menghasilkan ERR_ABORTED walau halaman
      // tujuan sebenarnya sudah dimuat.
      if (!/ERR_ABORTED/i.test(String(error.message))) {
        throw error;
      }
    }

    await page
      .locator("body")
      .first()
      .waitFor({ state: "visible", timeout: this.timeouts.elementTimeout })
      .catch(() => {});
  }

  async _ensureSpotifyPage() {
    const page = await this.getPage();
    const url = page.url();

    // Jangan menavigasi paksa saat pengguna sedang di halaman login
    // Spotify. Command yang butuh login akan memberi pesan yang jelas.
    if (
      !url.startsWith(this.origin) &&
      !url.startsWith("https://accounts.spotify.com")
    ) {
      await this._goto(page, `${this.origin}/`);
    }

    return page;
  }

  async _recover() {
    if (!this._browser || !this._browser.isConnected()) {
      this._browser = null;
      this._context = null;
    }

    this._page = null;
    this._loggedPageDiscovery = false;
  }

  async _withRecovery(operationName, operation) {
    let attemptedRecovery = false;

    while (true) {
      try {
        const page = await this._ensureSpotifyPage();

        return await operation(page);
      } catch (error) {
        if (attemptedRecovery || !isRecoverableError(error)) {
          throw error;
        }

        attemptedRecovery = true;
        warn(
          `${operationName} gagal karena koneksi/tab bermasalah. ` +
            "Mencoba memulihkan koneksi Spotify..."
        );

        await this._recover();
      }
    }
  }

  async _visible(locator) {
    return locator
      .first()
      .isVisible()
      .catch(() => false);
  }

  async _assertLoggedIn(page) {
    const loginButton = page.locator('[data-testid="login-button"]');
    const userWidget = page.locator(
      '[data-testid="user-widget-link"], ' +
        '[data-testid="user-widget-dropdown"], ' +
        '[data-testid="user-widget-avatar"], ' +
        '[data-testid="user-widget"]'
    );

    if (await this._visible(userWidget)) {
      return true;
    }

    if (await this._visible(loginButton)) {
      throw new SpotifyError(
        "Spotify Web belum login. Login sekali di tab Spotify pada Brave " +
          "automation (profil khusus), lalu kirim ulang perintah.",
        "NOT_LOGGED_IN"
      );
    }

    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
      if (await this._visible(userWidget)) {
        return true;
      }

      if (await this._visible(loginButton)) {
        throw new SpotifyError(
          "Spotify Web belum login. Login sekali di tab Spotify pada Brave " +
            "automation (profil khusus), lalu kirim ulang perintah.",
          "NOT_LOGGED_IN"
        );
      }

      await page.waitForTimeout(this.timeouts.pollInterval);
    }

    throw new SpotifyError(
      "Status login Spotify tidak dapat dipastikan. Pastikan halaman " +
        "Spotify Web sudah selesai dimuat di Brave.",
      "LOGIN_UNKNOWN"
    );
  }

  async _readStatus(page) {
    const data = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);

        return (
          Boolean(
            element.offsetWidth ||
              element.offsetHeight ||
              element.getClientRects().length
          ) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };

      const textOf = (element) =>
        element ? String(element.textContent || "").trim() : null;

      const findVisible = (selectors) => {
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);

          for (const element of elements) {
            if (isVisible(element)) {
              return element;
            }
          }
        }

        return null;
      };

      const titleElement = findVisible([
        '[data-testid="context-item-link"]',
        '[data-testid="now-playing-widget"] a[href*="/track/"]',
        '[data-testid="now-playing-bar"] a[href*="/track/"]',
        '[data-testid="context-item-info-title"]',
        '[data-testid="now-playing-widget"] [data-testid="context-item-info-title"]'
      ]);

      const artistElement = findVisible([
        '[data-testid="context-item-info-artist"]',
        '[data-testid="now-playing-widget"] a[href*="/artist/"]',
        '[data-testid="now-playing-bar"] a[href*="/artist/"]'
      ]);

      const titleLink =
        (titleElement && titleElement.closest("a")) ||
        (titleElement &&
          titleElement.querySelector &&
          titleElement.querySelector('a[href*="/track/"]')) ||
        null;

      const progress = document.querySelector(
        '[data-testid="playback-progressbar"]'
      );

      let position = textOf(
        document.querySelector('[data-testid="playback-position"]')
      );
      let duration = textOf(
        document.querySelector('[data-testid="playback-duration"]')
      );

      const valueText = progress?.getAttribute("aria-valuetext") || "";
      const valueMatch = valueText.match(
        /(\d+:\d+)\s*(?:of|\/|dari|-)\s*(\d+:\d+)/i
      );

      if (valueMatch) {
        position = position && position !== "-:--" ? position : valueMatch[1];
        duration = duration && duration !== "-:--" ? duration : valueMatch[2];
      }

      const valueNow = progress?.getAttribute("aria-valuenow");
      const valueMax = progress?.getAttribute("aria-valuemax");

      const playPause = document.querySelector(
        '[data-testid="control-button-playpause"]'
      );
      const playPauseLabel = playPause?.getAttribute("aria-label") || "";

      let playbackState = "unknown";

      if (/pause|jeda/i.test(playPauseLabel)) {
        playbackState = "playing";
      } else if (/play|putar|mainkan/i.test(playPauseLabel)) {
        playbackState = "paused";
      }

      return {
        title: textOf(titleElement),
        artist: textOf(artistElement),
        trackHref: titleLink?.getAttribute("href") || null,
        positionText: position,
        durationText: duration,
        positionValue: valueNow === null ? null : Number(valueNow),
        durationValue: valueMax === null ? null : Number(valueMax),
        playbackState,
        playPauseLabel
      };
    });

    const trackId = extractTrackId(data.trackHref);
    const position =
      (data.positionText && data.positionText !== "-:--"
        ? data.positionText
        : null) || formatSeconds(data.positionValue);
    const duration =
      (data.durationText && data.durationText !== "-:--"
        ? data.durationText
        : null) || formatSeconds(data.durationValue);

    return {
      title: data.title || null,
      artist: data.artist || null,
      position,
      duration,
      positionSeconds: Number.isFinite(data.positionValue)
        ? data.positionValue
        : null,
      durationSeconds: Number.isFinite(data.durationValue)
        ? data.durationValue
        : null,
      state: data.playbackState,
      isPlaying: data.playbackState === "playing",
      trackId,
      trackUrl: data.trackHref ? absoluteSpotifyUrl(data.trackHref) : null
    };
  }

  async _waitForState(page, expectedState) {
    const deadline = Date.now() + this.timeouts.verifyTimeout;
    let lastStatus = null;

    while (Date.now() < deadline) {
      lastStatus = await this._readStatus(page);

      if (lastStatus.state === expectedState) {
        return lastStatus;
      }

      await page.waitForTimeout(this.timeouts.pollInterval);
    }

    throw new SpotifyError(
      `Status pemutaran tidak berubah menjadi "${expectedState}". ` +
        "Pastikan tidak ada dialog login/premium di Spotify Web.",
      "PLAYBACK_STATE_UNVERIFIED",
      lastStatus
    );
  }

  async _clickControl(page, selector, description) {
    const control = page.locator(selector).first();

    if (!(await control.count())) {
      throw new SpotifyError(
        `Kontrol ${description} tidak ditemukan di Spotify Web.`,
        "CONTROL_NOT_FOUND"
      );
    }

    await control
      .waitFor({ state: "visible", timeout: this.timeouts.elementTimeout })
      .catch(() => {
        throw new SpotifyError(
          `Kontrol ${description} tidak terlihat di Spotify Web.`,
          "CONTROL_NOT_VISIBLE"
        );
      });

    if (!(await control.isEnabled().catch(() => false))) {
      throw new SpotifyError(
        `Kontrol ${description} sedang tidak tersedia. ` +
          "Pastikan ada lagu yang sedang diputar.",
        "CONTROL_DISABLED"
      );
    }

    await control.scrollIntoViewIfNeeded().catch(() => {});
    await control.click({ timeout: this.timeouts.elementTimeout });

    return control;
  }

  async _openSearch(page, query) {
    await this._goto(
      page,
      `${this.origin}/search/${encodeURIComponent(query)}`
    );

    // Tunggu hasil nyata muncul, bukan hanya skeleton/loading.
    await page
      .locator(
        'main a[href*="/track/"]:visible, ' +
          'main a[href*="/playlist/"]:visible'
      )
      .first()
      .waitFor({
        state: "visible",
        timeout: this.timeouts.searchTimeout
      })
      .catch(() => {});

    // Beri waktu singkat hanya sampai elemen hasil berikutnya
    // selesai dirender. Jika tidak ada hasil, collect akan kosong.
    await page.waitForTimeout(400);
  }

  async _collectTrackResults(page) {
    const rawResults = await page.evaluate(() => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);

        return (
          Boolean(
            element.offsetWidth ||
              element.offsetHeight ||
              element.getClientRects().length
          ) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };

      const textOf = (element) =>
        element ? String(element.textContent || "").trim() : "";

      return Array.from(
        document.querySelectorAll('main a[href*="/track/"]')
      )
        .filter((link) => isVisible(link))
        .map((link) => {
          let row = link.closest('[data-testid="tracklist-row"]');

          if (!row) {
            let node = link.parentElement;

            while (node && node !== document.body) {
              if (node.querySelector('a[href*="/artist/"]')) {
                row = node;
                break;
              }

              if ((node.textContent || "").length > 600) {
                break;
              }

              node = node.parentElement;
            }
          }

          const titleElement =
            (row &&
              row.querySelector(
                '[data-testid="internal-track-link"], a[href*="/track/"]'
              )) ||
            link;

          const artists = row
            ? Array.from(row.querySelectorAll('a[href*="/artist/"]')).map(
                textOf
              )
            : [];

          const playButton = row
            ? Array.from(row.querySelectorAll("button")).find((button) =>
                /^play\b/i.test(button.getAttribute("aria-label") || "")
              )
            : null;

          return {
            href: link.getAttribute("href"),
            title: textOf(titleElement),
            artists: artists.filter(Boolean),
            hasRow: Boolean(row),
            playLabel: playButton
              ? playButton.getAttribute("aria-label")
              : null
          };
        })
        .filter((result) => result.href && result.title);
    });

    const merged = new Map();

    for (const result of rawResults) {
      const id = extractTrackId(result.href);

      if (!id) {
        continue;
      }

      const candidate = {
        ...result,
        id,
        url: absoluteSpotifyUrl(result.href)
      };

      const existing = merged.get(id);

      if (!existing) {
        merged.set(id, candidate);
        continue;
      }

      // Hasil "Top result" dan tracklist bisa menunjuk track yang
      // sama. Pilih entri yang punya baris dan tombol Play.
      const candidateScore =
        (candidate.hasRow ? 2 : 0) + (candidate.playLabel ? 1 : 0);
      const existingScore =
        (existing.hasRow ? 2 : 0) + (existing.playLabel ? 1 : 0);

      if (candidateScore > existingScore) {
        merged.set(id, candidate);
      } else if (!existing.artists.length && candidate.artists.length) {
        merged.set(id, candidate);
      }
    }

    return Array.from(merged.values());
  }

  async _collectPlaylistResults(page) {
    const rawResults = await page.evaluate(() => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);

        return (
          Boolean(
            element.offsetWidth ||
              element.offsetHeight ||
              element.getClientRects().length
          ) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };

      return Array.from(
        document.querySelectorAll('main a[href*="/playlist/"]')
      )
        .filter((link) => isVisible(link))
        .map((link) => ({
          href: link.getAttribute("href"),
          title: String(link.textContent || "").trim()
        }))
        .filter((result) => result.href && result.title);
    });

    const merged = new Map();

    for (const result of rawResults) {
      const id = extractPlaylistId(result.href);

      if (!id) {
        continue;
      }

      const existing = merged.get(id);

      if (!existing || result.title.length > existing.title.length) {
        merged.set(id, {
          ...result,
          id,
          url: absoluteSpotifyUrl(result.href)
        });
      }
    }

    return Array.from(merged.values());
  }

  async _findTrackOnPage(page, query) {
    const queryInfo = parseTrackQuery(query);

    if (!queryInfo.searchQuery) {
      throw new SpotifyError(
        "Masukkan judul lagu yang ingin diputar.",
        "EMPTY_QUERY"
      );
    }

    await this._openSearch(page, queryInfo.searchQuery);

    const results = await this._collectTrackResults(page);

    if (!results.length) {
      throw new SpotifyError(
        `Lagu "${queryInfo.searchQuery}" tidak ditemukan di Spotify.`,
        "NO_RESULTS",
        { query: queryInfo.searchQuery }
      );
    }

    const selected = selectBestTrack(results, queryInfo);

    if (!selected) {
      throw new SpotifyError(
        `Tidak ada hasil lagu yang cocok untuk "${queryInfo.searchQuery}".`,
        "NO_MATCH",
        { query: queryInfo.searchQuery }
      );
    }

    return { queryInfo, results, selected };
  }

  async _waitForPlayback(page, expectedTrack) {
    const deadline = Date.now() + this.timeouts.verifyTimeout;
    let lastStatus = null;

    while (Date.now() < deadline) {
      lastStatus = await this._readStatus(page);

      const trackIdMatches =
        expectedTrack.id &&
        lastStatus.trackId &&
        expectedTrack.id === lastStatus.trackId;

      const titleMatches =
        expectedTrack.title &&
        lastStatus.title &&
        textSimilarity(expectedTrack.title, lastStatus.title) >= 0.72;

      if (
        lastStatus.state === "playing" &&
        (trackIdMatches || titleMatches)
      ) {
        return lastStatus;
      }

      await page.waitForTimeout(this.timeouts.pollInterval);
    }

    const lastDescription = lastStatus?.title
      ? `"${lastStatus.title}" (${lastStatus.state})`
      : "tidak ada lagu";

    throw new SpotifyError(
      `Spotify tidak terverifikasi memutar "${expectedTrack.title}". ` +
        `Status terakhir: ${lastDescription}. ` +
        "Pastikan akun sudah login, lagu tersedia, dan tidak ada dialog premium.",
      "PLAYBACK_UNVERIFIED",
      lastStatus
    );
  }

  async _startTrack(page, selected) {
    const row = page
      .locator('[data-testid="tracklist-row"]')
      .filter({
        has: page.locator(`a[href*="/track/${selected.id}"]`)
      })
      .first();

    let button = null;

    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});

      const rowButton = row
        .locator(
          'button[data-testid="play-button"], button[aria-label^="Play "]'
        )
        .first();

      if (await rowButton.count()) {
        if (!(await this._visible(rowButton))) {
          await row.hover().catch(() => {});
          await rowButton
            .waitFor({
              state: "visible",
              timeout: 2000
            })
            .catch(() => {});
        }

        if (await this._visible(rowButton)) {
          button = rowButton;
        }
      }
    }

    if (!button) {
      const titlePattern = selected.title.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const byLabel = page
        .getByRole("button", {
          name: new RegExp(`^Play\\s+${titlePattern}(\\s+by\\s+|$)`, "i")
        })
        .first();

      if (await this._visible(byLabel)) {
        button = byLabel;
      }
    }

    if (button) {
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ timeout: this.timeouts.elementTimeout });

      return;
    }

    // Fallback: buka halaman track hasil pencarian, lalu gunakan
    // tombol Play utama di halaman tersebut.
    if (!selected.url) {
      throw new SpotifyError(
        `Lagu "${selected.title}" ditemukan, tetapi URL track tidak terbaca.`,
        "TRACK_URL_MISSING"
      );
    }

    await this._goto(page, selected.url);

    const headerPlay = page
      .locator(
        'main [data-testid="action-bar-row"] [data-testid="play-button"], ' +
          'main button[data-testid="play-button"]'
      )
      .first();

    if (!(await headerPlay.count())) {
      throw new SpotifyError(
        `Lagu "${selected.title}" ditemukan, tetapi tombol Play tidak ada.`,
        "PLAY_BUTTON_MISSING"
      );
    }

    await headerPlay
      .waitFor({ state: "visible", timeout: this.timeouts.elementTimeout })
      .catch(() => {
        throw new SpotifyError(
          "Tombol Play di halaman lagu tidak terlihat.",
          "PLAY_BUTTON_NOT_VISIBLE"
        );
      });

    const label = (await headerPlay.getAttribute("aria-label")) || "";

    if (!/pause|jeda/i.test(label)) {
      await headerPlay.click({ timeout: this.timeouts.elementTimeout });
    }
  }

  async _waitForTransition(page, before) {
    const deadline = Date.now() + this.timeouts.transitionTimeout;
    let lastStatus = null;

    while (Date.now() < deadline) {
      lastStatus = await this._readStatus(page);

      const idChanged =
        before.trackId &&
        lastStatus.trackId &&
        before.trackId !== lastStatus.trackId;

      const titleChanged =
        before.title &&
        lastStatus.title &&
        textSimilarity(before.title, lastStatus.title) < 0.5;

      const positionReset =
        before.positionSeconds !== null &&
        lastStatus.positionSeconds !== null &&
        lastStatus.positionSeconds + 1 < before.positionSeconds;

      if (idChanged || titleChanged || positionReset) {
        return { status: lastStatus, verified: true };
      }

      await page.waitForTimeout(this.timeouts.pollInterval);
    }

    return { status: lastStatus || before, verified: false };
  }

  async _waitForPlaylistStart(page, before) {
    const deadline = Date.now() + this.timeouts.verifyTimeout;
    let lastStatus = null;

    while (Date.now() < deadline) {
      lastStatus = await this._readStatus(page);

      if (lastStatus.state !== "playing" || !lastStatus.title) {
        await page.waitForTimeout(this.timeouts.pollInterval);
        continue;
      }

      const wasAlreadyPlaying = before.state === "playing";

      const idChanged =
        before.trackId &&
        lastStatus.trackId &&
        before.trackId !== lastStatus.trackId;

      const titleChanged =
        before.title &&
        lastStatus.title &&
        textSimilarity(before.title, lastStatus.title) < 0.5;

      const positionReset =
        before.positionSeconds !== null &&
        lastStatus.positionSeconds !== null &&
        lastStatus.positionSeconds + 1 < before.positionSeconds;

      if (
        !wasAlreadyPlaying ||
        !before.title ||
        idChanged ||
        titleChanged ||
        positionReset
      ) {
        return lastStatus;
      }

      await page.waitForTimeout(this.timeouts.pollInterval);
    }

    const lastDescription = lastStatus?.title
      ? `"${lastStatus.title}" (${lastStatus.state})`
      : "tidak ada lagu";

    throw new SpotifyError(
      "Spotify belum terverifikasi mulai memutar playlist. " +
        `Status terakhir: ${lastDescription}.`,
      "PLAYBACK_UNVERIFIED",
      lastStatus
    );
  }

  // =========================================================
  // PUBLIC OPERATIONS
  // =========================================================

  async current() {
    return this.enqueue(() =>
      this._withRecovery("current", async (page) => {
        await this._assertLoggedIn(page);
        return this._readStatus(page);
      })
    );
  }

  async getPlaybackStatus() {
    return this.current();
  }

  async play() {
    return this.enqueue(() =>
      this._withRecovery("play", async (page) => {
        await this._assertLoggedIn(page);

        const before = await this._readStatus(page);

        if (before.state === "playing") {
          return { alreadyPlaying: true, status: before };
        }

        if (before.state !== "paused") {
          throw new SpotifyError(
            "Status tombol Play/Pause Spotify tidak dapat dikenali.",
            "PLAYBACK_STATE_UNKNOWN",
            before
          );
        }

        await this._clickControl(page, CONTROL.playPause, "Play/Pause");
        const status = await this._waitForState(page, "playing");

        return { alreadyPlaying: false, status };
      })
    );
  }

  async pause() {
    return this.enqueue(() =>
      this._withRecovery("pause", async (page) => {
        await this._assertLoggedIn(page);

        const before = await this._readStatus(page);

        if (before.state === "paused") {
          return { alreadyPaused: true, status: before };
        }

        if (before.state !== "playing") {
          throw new SpotifyError(
            "Status tombol Play/Pause Spotify tidak dapat dikenali.",
            "PLAYBACK_STATE_UNKNOWN",
            before
          );
        }

        await this._clickControl(page, CONTROL.playPause, "Play/Pause");
        const status = await this._waitForState(page, "paused");

        return { alreadyPaused: false, status };
      })
    );
  }

  async playpause() {
    return this.enqueue(() =>
      this._withRecovery("playpause", async (page) => {
        await this._assertLoggedIn(page);

        const before = await this._readStatus(page);
        const targetState =
          before.state === "playing" ? "paused" : "playing";

        if (before.state !== "playing" && before.state !== "paused") {
          throw new SpotifyError(
            "Status tombol Play/Pause Spotify tidak dapat dikenali.",
            "PLAYBACK_STATE_UNKNOWN",
            before
          );
        }

        await this._clickControl(page, CONTROL.playPause, "Play/Pause");
        const status = await this._waitForState(page, targetState);

        return { toggledTo: targetState, status };
      })
    );
  }

  async next() {
    return this.enqueue(() =>
      this._withRecovery("next", async (page) => {
        await this._assertLoggedIn(page);

        const before = await this._readStatus(page);

        await this._clickControl(page, CONTROL.next, "Next");
        const transition = await this._waitForTransition(page, before);

        return {
          before,
          after: transition.status,
          verified: transition.verified
        };
      })
    );
  }

  async previous() {
    return this.enqueue(() =>
      this._withRecovery("previous", async (page) => {
        await this._assertLoggedIn(page);

        const before = await this._readStatus(page);

        await this._clickControl(page, CONTROL.previous, "Previous");
        const transition = await this._waitForTransition(page, before);

        return {
          before,
          after: transition.status,
          verified: transition.verified
        };
      })
    );
  }

  async searchTrack(query) {
    return this.enqueue(() =>
      this._withRecovery("searchTrack", async (page) => {
        const found = await this._findTrackOnPage(page, query);

        return {
          query: found.queryInfo.raw,
          title: found.queryInfo.title,
          artist: found.queryInfo.artist,
          selected: found.selected,
          results: found.results
        };
      })
    );
  }

  async playTrack(query) {
    return this.enqueue(() =>
      this._withRecovery("playTrack", async (page) => {
        await this._assertLoggedIn(page);

        const found = await this._findTrackOnPage(page, query);

        await this._startTrack(page, found.selected);

        const status = await this._waitForPlayback(
          page,
          found.selected
        );

        return {
          query: found.queryInfo.raw,
          selected: found.selected,
          status
        };
      })
    );
  }

  async searchPlaylist(query) {
    return this.enqueue(() =>
      this._withRecovery("searchPlaylist", async (page) => {
        const searchQuery = String(query || "").trim();

        if (!searchQuery) {
          throw new SpotifyError(
            "Masukkan nama playlist yang ingin dicari.",
            "EMPTY_QUERY"
          );
        }

        await this._openSearch(page, searchQuery);

        const results = await this._collectPlaylistResults(page);

        if (!results.length) {
          throw new SpotifyError(
            `Playlist "${searchQuery}" tidak ditemukan di Spotify.`,
            "NO_RESULTS",
            { query: searchQuery }
          );
        }

        return {
          query: searchQuery,
          selected: selectBestPlaylist(results, searchQuery),
          results
        };
      })
    );
  }

  async playPlaylist(query) {
    return this.enqueue(() =>
      this._withRecovery("playPlaylist", async (page) => {
        await this._assertLoggedIn(page);

        const searchQuery = String(query || "").trim();

        if (!searchQuery) {
          throw new SpotifyError(
            "Masukkan nama playlist yang ingin diputar.",
            "EMPTY_QUERY"
          );
        }

        await this._openSearch(page, searchQuery);

        const results = await this._collectPlaylistResults(page);

        if (!results.length) {
          throw new SpotifyError(
            `Playlist "${searchQuery}" tidak ditemukan di Spotify.`,
            "NO_RESULTS",
            { query: searchQuery }
          );
        }

        const selected = selectBestPlaylist(results, searchQuery);

        if (!selected?.url) {
          throw new SpotifyError(
            `Playlist "${searchQuery}" ditemukan, tetapi URL playlist tidak terbaca.`,
            "PLAYLIST_URL_MISSING"
          );
        }

        const before = await this._readStatus(page);

        await this._goto(page, selected.url);

        await page
          .locator(
            'main [data-testid="playlist-page"], ' +
              'main [data-testid="play-button"]'
          )
          .first()
          .waitFor({
            state: "visible",
            timeout: this.timeouts.elementTimeout
          })
          .catch(() => {});

        const playlistPlay = page
          .locator(
            'main [data-testid="action-bar-row"] [data-testid="play-button"], ' +
              'main button[data-testid="play-button"]'
          )
          .first();

        if (!(await playlistPlay.count())) {
          throw new SpotifyError(
            `Playlist "${selected.title}" ditemukan, tetapi tombol Play tidak ada.`,
            "PLAY_BUTTON_MISSING"
          );
        }

        await playlistPlay
          .waitFor({ state: "visible", timeout: this.timeouts.elementTimeout })
          .catch(() => {
            throw new SpotifyError(
              "Tombol Play playlist tidak terlihat.",
              "PLAY_BUTTON_NOT_VISIBLE"
            );
          });

        const label = (await playlistPlay.getAttribute("aria-label")) || "";

        if (!/pause|jeda/i.test(label)) {
          await playlistPlay.click({ timeout: this.timeouts.elementTimeout });
        }

        const status = await this._waitForPlaylistStart(page, before);

        return { query: searchQuery, selected, status };
      })
    );
  }
}

const controller = new SpotifyController();

module.exports = controller;
module.exports.SpotifyController = SpotifyController;
module.exports.SpotifyError = SpotifyError;
module.exports.parseTrackQuery = parseTrackQuery;
module.exports.selectBestTrack = selectBestTrack;
module.exports.selectBestPlaylist = selectBestPlaylist;
module.exports.textSimilarity = textSimilarity;
module.exports.normalizeText = normalizeText;
module.exports.formatSeconds = formatSeconds;
module.exports.status = (...args) => controller.getPlaybackStatus(...args);
