const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// ==========================================
// CONFIGURATION
// ==========================================

const PROFILE_PATH = path.join(process.cwd(), ".spotify-profile");

const PLAY_PAUSE = '[data-testid="control-button-playpause"]';
const NEXT_BUTTON = '[data-testid="control-button-skip-forward"]';
const PREV_BUTTON = '[data-testid="control-button-skip-back"]';

let browserContext = null;
let spotifyPage = null;
let initPromise = null;
let commandQueue = Promise.resolve();

// Deteksi lokasi Brave secara otomatis.
function findBrave() {
  const candidates = [
    process.env.BRAVE_PATH,
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe"
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe"
    ),
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe"
        )
      : null,
  ];

  return candidates.find(
    (candidate) => candidate && fs.existsSync(candidate)
  );
}

// ==========================================
// BRAVE / SPOTIFY INITIALIZATION
// ==========================================

async function initSpotify() {
  if (
    browserContext &&
    spotifyPage &&
    !spotifyPage.isClosed()
  ) {
    return spotifyPage;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const bravePath = findBrave();

    if (!bravePath) {
      throw new Error(
        "Brave tidak ditemukan. Periksa instalasi Brave atau konfigurasi BRAVE_PATH."
      );
    }

    fs.mkdirSync(PROFILE_PATH, { recursive: true });

    browserContext = await chromium.launchPersistentContext(
      PROFILE_PATH,
      {
        executablePath: bravePath,
        headless: false,
        viewport: null,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
        ],
      }
    );

    browserContext.on("close", () => {
      browserContext = null;
      spotifyPage = null;
    });

    spotifyPage =
      browserContext.pages()[0] ||
      (await browserContext.newPage());

    spotifyPage.setDefaultTimeout(12000);

    if (
      !spotifyPage.url().startsWith(
        "https://open.spotify.com"
      )
    ) {
      await spotifyPage.goto("https://open.spotify.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    await spotifyPage.waitForTimeout(3000);

    return spotifyPage;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

async function findFirst(page, selectors) {
  for (const selector of selectors) {
    const element = page.locator(selector).first();

    if (await element.count()) {
      return element;
    }
  }

  return null;
}

async function getButtonLabel(button) {
  if (!button) return "";

  return (
    (await button.getAttribute("aria-label")) ||
    (await button.getAttribute("title")) ||
    ""
  ).trim();
}

function formatSeconds(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const seconds = Number(value);

  if (!Number.isFinite(seconds)) {
    return null;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

async function sendReply(sock, msg, text) {
  await sock.sendMessage(
    msg.key.remoteJid,
    { text },
    { quoted: msg }
  );
}

// ==========================================
// SPOTIFY STATUS
// ==========================================

async function getSpotifyStatus(page) {
  const titleElement = await findFirst(page, [
    '[data-testid="context-item-link"]',
    '[data-testid="now-playing-widget"] a[href*="/track/"]',
  ]);

  const artistElement = await findFirst(page, [
    '[data-testid="context-item-info-artist"]',
    '[data-testid="now-playing-widget"] a[href*="/artist/"]',
  ]);

  const title = titleElement
    ? (await titleElement.innerText()).trim()
    : "Tidak ada lagu";

  const artist = artistElement
    ? (await artistElement.innerText()).trim()
    : "Tidak diketahui";

  let position = "Tidak diketahui";
  let duration = "Tidak diketahui";

  const progress = await findFirst(page, [
    '[data-testid="playback-progressbar"]',
    '[aria-label="Change progress"]',
  ]);

  if (progress) {
    const valueText = await progress.getAttribute(
      "aria-valuetext"
    );

    if (valueText) {
      const match = valueText.match(
        /(\d+:\d+)\s+of\s+(\d+:\d+)/i
      );

      if (match) {
        position = match[1];
        duration = match[2];
      } else {
        position = valueText;
      }
    } else {
      const current = await progress.getAttribute(
        "aria-valuenow"
      );

      const maximum = await progress.getAttribute(
        "aria-valuemax"
      );

      position = formatSeconds(current) || position;
      duration = formatSeconds(maximum) || duration;
    }
  }

  const playPause = page.locator(PLAY_PAUSE).first();
  let playback = "Tidak diketahui";

  if (await playPause.count()) {
    const label = await getButtonLabel(playPause);

    if (/pause/i.test(label)) {
      playback = "Playing";
    } else if (/play/i.test(label)) {
      playback = "Paused";
    }
  }

  return [
    "🎧 SPOTIFY STATUS",
    `🎵 Lagu: ${title || "Tidak ada lagu"}`,
    `👤 Artis: ${artist || "Tidak diketahui"}`,
    `⏱️ Posisi: ${position} / ${duration}`,
    `▶️ Status: ${playback}`,
  ].join("\n");
}

// ==========================================
// PLAY SONG / PLAYLIST
// ==========================================

async function clickPagePlayButton(page) {
  const selectors = [
    'main button[data-testid="play-button"]',
    'main button[aria-label*="Play"]',
    'main button[title*="Play"]',
    'button[data-testid="play-button"]',
    'button[aria-label*="Play"]',
  ];

  for (const selector of selectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);

      if (!(await button.isVisible().catch(() => false))) {
        continue;
      }

      if (!(await button.isEnabled().catch(() => false))) {
        continue;
      }

      const label = await getButtonLabel(button);

      // Jangan menekan tombol yang sudah berstatus Pause.
      if (/pause/i.test(label)) {
        continue;
      }

      try {
        await button.scrollIntoViewIfNeeded();
        await button.click({ timeout: 8000 });

        await page.waitForTimeout(2000);

        const playPause = page
          .locator(PLAY_PAUSE)
          .first();

        const currentLabel = await getButtonLabel(playPause);

        if (/pause/i.test(currentLabel)) {
          return true;
        }
      } catch (error) {
        console.log(
          `[SPOTIFY] Gagal klik selector ${selector}: ${error.message}`
        );
      }
    }
  }

  return false;
}

async function playSpotify(page, input) {
  const query = input.trim();

  if (!query) {
    return {
      success: false,
      message:
        "🎵 Masukkan judul lagu atau playlist.\n\n" +
        "Contoh: .play i love her so much",
    };
  }

  const isPlaylist = /^playlist\s+/i.test(query);
  const searchQuery = isPlaylist
    ? query.replace(/^playlist\s+/i, "").trim()
    : query;

  if (!searchQuery) {
    return {
      success: false,
      message: "❌ Nama playlist belum diberikan.",
    };
  }

  const searchUrl =
    "https://open.spotify.com/search/" +
    encodeURIComponent(searchQuery);

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3500);

  // ----------------------------------------
  // PLAY PLAYLIST
  // ----------------------------------------

  if (isPlaylist) {
    const playlistLink = await findFirst(page, [
      'a[href*="/playlist/"]',
    ]);

    if (!playlistLink) {
      return {
        success: false,
        message: `❌ Playlist "${searchQuery}" tidak ditemukan.`,
      };
    }

    const href = await playlistLink.getAttribute("href");

    if (!href) {
      return {
        success: false,
        message: "❌ Link playlist tidak ditemukan.",
      };
    }

    const playlistUrl = new URL(
      href,
      "https://open.spotify.com"
    ).toString();

    await page.goto(playlistUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    const clicked = await clickPagePlayButton(page);

    if (!clicked) {
      return {
        success: false,
        message:
          "⚠️ Playlist ditemukan",
      };
    }

    return {
      success: true,
      message: `Memutar playlist: ${searchQuery}`,
    };
  }

  // ----------------------------------------
  // PLAY SONG
  // ----------------------------------------

  // Jangan hanya bergantung pada data-testid="tracklist-row".
  // Spotify dapat mengubah struktur baris hasil pencarian, tetapi
  // tautan ke halaman track biasanya tetap tersedia.
  const trackSelectors = [
    'main a[href*="/track/"]',
    '[data-testid="main-view-container"] a[href*="/track/"]',
    'a[href*="/track/"]',
  ];

  let trackUrl = null;
  let trackTitle = searchQuery;

  for (const selector of trackSelectors) {
    const trackLinks = page.locator(selector);
    const count = await trackLinks.count();

    for (let i = 0; i < count; i++) {
      const trackLink = trackLinks.nth(i);

      if (!(await trackLink.isVisible().catch(() => false))) {
        continue;
      }

      const href = await trackLink.getAttribute("href");
      if (!href) continue;

      try {
        const candidate = new URL(
          href,
          "https://open.spotify.com"
        );

        if (!/^\/track\/[A-Za-z0-9]+/.test(candidate.pathname)) {
          continue;
        }

        trackUrl = candidate.toString();
        trackTitle =
          (await trackLink.innerText().catch(() => "")).trim() ||
          searchQuery;
        break;
      } catch {
        continue;
      }
    }

    if (trackUrl) break;
  }

  if (!trackUrl) {
    return {
      success: false,
      message:
        `❌ Hasil pencarian muncul, tetapi link lagu "${searchQuery}" tidak berhasil dibaca. ` +
        "Kemungkinan struktur hasil pencarian Spotify berubah atau hasil belum selesai dimuat.",
    };
  }

  // Buka halaman track secara langsung, lalu gunakan tombol Play
  // di halaman tersebut. Ini tidak bergantung pada tracklist-row.
  await page.goto(trackUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  const clicked = await clickPagePlayButton(page);

  if (clicked) {
    return {
      success: true,
      message: `▶️ Memutar: ${trackTitle}`,
    };
  }

  return {
    success: false,
    message:
      `⚠️ Lagu "${trackTitle}" ditemukan, tetapi tombol Play tidak terdeteksi. ` +
      "Kemungkinan tampilan Spotify Web berubah atau akun tidak dapat memutar lagu tersebut.",
  };
}

// ==========================================
// COMMAND EXECUTOR
// ==========================================

async function executeCommand(sock, msg, args, command) {
  const rawAction = (command || args[0] || "")
    .toLowerCase()
    .trim();

  const action = {
    n: "next",
    pre: "prev",
  }[rawAction] || rawAction;

  try {
    const page = await initSpotify();

    // Pastikan halaman Spotify sudah terbuka dan login.
    let playPause = page.locator(PLAY_PAUSE).first();

    try {
      await playPause.waitFor({
        state: "attached",
        timeout: 12000,
      });
    } catch {
      await sendReply(
        sock,
        msg,
        "Spotify Web sudah dibuka di Brave.\n" +
          "Silakan login terlebih dahulu, lalu kirim ulang perintah."
      );
      return;
    }

    switch (action) {
      case "spotatus": {
        const status = await getSpotifyStatus(page);
        await sendReply(sock, msg, status);
        break;
      }

      case "pause": {
        const label = await getButtonLabel(playPause);

        if (/pause/i.test(label)) {
          await playPause.click();
          await sendReply(sock, msg, "⏸️ Spotify dijeda.");
        } else if (/play/i.test(label)) {
          await sendReply(sock, msg, "⏸️ Spotify sudah dijeda.");
        } else {
          await sendReply(
            sock,
            msg,
            "⚠️ Status tombol pemutaran tidak dapat dikenali."
          );
        }

        break;
      }

      case "next": {
        const nextButton = page
          .locator(NEXT_BUTTON)
          .first();

        if (!(await nextButton.count())) {
          await sendReply(
            sock,
            msg,
            "❌ Tombol Next tidak ditemukan."
          );
          return;
        }

        await nextButton.click();
        await sendReply(
          sock,
          msg,
          "⏭️ Beralih ke lagu berikutnya."
        );
        break;
      }

      case "prev":
      case "previous": {
        const prevButton = page
          .locator(PREV_BUTTON)
          .first();

        if (!(await prevButton.count())) {
          await sendReply(
            sock,
            msg,
            "❌ Tombol Previous tidak ditemukan."
          );
          return;
        }

        await prevButton.click();
        await sendReply(
          sock,
          msg,
          "⏮️ Kembali ke lagu sebelumnya."
        );
        break;
      }

      case "play": {
        const query = args.join(" ").trim();

        // .play tanpa argumen berarti melanjutkan lagu.
        if (!query) {
          const label = await getButtonLabel(playPause);

          if (/play/i.test(label) && !/pause/i.test(label)) {
            await playPause.click();
            await sendReply(
              sock,
              msg,
              "▶️ Melanjutkan pemutaran Spotify."
            );
          } else {
            await sendReply(
              sock,
              msg,
              "🎵 Spotify sedang memutar lagu.\n" +
                "Gunakan .play judul lagu untuk mencari lagu lain."
            );
          }

          return;
        }

        await sendReply(
          sock,
          msg,
          `🔎 Mencari di Spotify: ${query}`
        );

        const result = await playSpotify(page, query);

        await sendReply(sock, msg, result.message);
        break;
      }

      default: {
        await sendReply(
          sock,
          msg,
          "🎧 PERINTAH SPOTIFY\n\n" +
            ".play judul lagu\n" +
            ".play playlist nama playlist\n" +
            ".pause\n" +
            ".next\n" +
            ".prev\n" +
            ".spotatus"
        );
      }
    }
  } catch (error) {
    console.error("[SPOTIFY ERROR]", error);

    await sendReply(
      sock,
      msg,
      `❌ Gagal mengontrol Spotify: ${error.message}`
    );
  }
}

// ==========================================
// EXPORT
// ==========================================

module.exports = {
  name: "spotify",
  aliases: [
    "play",
    "pause",
    "next",
    "n",
    "prev",
    "pre",
    "previous",
    "spotatus",
  ],
  category: "system",
  description: "Mengontrol Spotify Web melalui Brave",

  execute(sock, msg, args, command) {
    // Antrean agar dua perintah tidak mengganggu
    // navigasi halaman Spotify secara bersamaan.
    const task = commandQueue.then(() =>
      executeCommand(sock, msg, args, command)
    );

    commandQueue = task.catch(() => {});
    return task;
  },
};