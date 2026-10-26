/* =========================================================
   JOY CONSOLE - MAIN ORCHESTRATOR
   ---------------------------------------------------------
   Menyatukan: logger, stats, group monitor, dashboard, dan
   command system. Menjalankan frame loop + prompt terminal.

   PENTING:
   - TIDAK membuat koneksi WhatsApp baru.
   - Hanya membaca socket & status dari index.js.
   - Tidak mengganggu pemrosesan pesan.
   ========================================================= */

const readline = require("readline");

const CONFIG = require("../config/joyConsole");
const logger = require("./logger");
const stats = require("./stats");
const groupMonitor = require("./groupMonitor");
const dashboard = require("./dashboard");
const commands = require("./commands");
const activity = require("../database/activity");
const botConfig = require("../config/bot");

/* ---------------------------------------------------------
   ANSI helpers
   --------------------------------------------------------- */

const ANSI = {
    clear: "\x1b[2J",
    home: "\x1b[H",
    hide: "\x1b[?25l",
    show: "\x1b[?25h",
    wrapOff: "\x1b[?7l",
    wrapOn: "\x1b[?7h",
    syncOn: "\x1b[?2026h",
    syncOff: "\x1b[?2026l"
};

const PROMPT = "> ";

/* ---------------------------------------------------------
   State
   --------------------------------------------------------- */

let initialized = false;
let interactive = false;
let started = false;
let bannerRenderer = null;
let tearingDown = false;
let shutdownHandler = null;

let rl = null;
let refreshTimer = null;
let resizeHandler = null;

let lastLines = [];
let lastWidth = -1;
let lastHeight = -1;

let notice = null;
let noticeUntil = 0;

const view = {
    current: "dashboard",
    previous: "dashboard",
    userQuery: "",
    logLevel: null,
    logLimit: 20,
    monitorJid: null
};

let pending = null;

const seenIds = new Set();
const seenOrder = [];

// Pesan yang lebih tua dari ini diabaikan dari pencatatan aktivitas.
// Berguna untuk syncFullHistory / reconnect agar pesan lama tidak
// dihitung sebagai aktivitas baru.
const MAX_RECORD_AGE_SECONDS = 60;

/* ---------------------------------------------------------
   Utilitas
   --------------------------------------------------------- */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWidth() {
    const w = process.stdout.columns;
    return Number.isFinite(w) && w > 20 ? w : 80;
}

function getHeight() {
    const h = process.stdout.rows;
    return Number.isFinite(h) && h > 5 ? h : 24;
}

function isInteractiveTerminal() {
    if (!CONFIG.enabled) return false;

    if (CONFIG.interactive === true) return true;
    if (CONFIG.interactive === false) return false;

    if (process.env.JOY_CONSOLE_DISABLE === "1") return false;
    if (process.env.TERM === "dumb") return false;

    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function padLine(line, width) {
    const visible = dashboard.stripAnsi(line).length;

    if (visible >= width) return line;

    return line + " ".repeat(width - visible);
}

function setNotice(message, ms = 4000) {
    notice = message ? String(message) : null;
    noticeUntil = Date.now() + ms;
}

/* ---------------------------------------------------------
   Pembangunan data per view
   --------------------------------------------------------- */

function collectDashboard() {
    return {
        system: stats.getSystemStats(),
        activity: stats.getActivityStats(),
        services: stats.getServiceStatus(),
        groups: stats.getGroups(),
        lastError: logger.getLastError(),
        logs: logger.getRecent({
            level: "warn",
            limit: CONFIG.layout.maxLogRows,
            includeMessage: false
        })
    };
}

function buildViewLines(width, height) {
    switch (view.current) {
        case "groups":
            return dashboard.renderGroups(
                { groups: stats.getGroups() },
                { width, height }
            );

        case "users":
            return dashboard.renderUsers(
                {
                    users: stats.getUsers(view.userQuery),
                    userQuery: view.userQuery
                },
                { width, height }
            );

        case "monitor": {
            const groups = stats.getGroups();
            const group = groups.find(
                (g) => g.jid === view.monitorJid
            ) || (view.monitorJid
                ? { jid: view.monitorJid, name: null }
                : null);

            return dashboard.renderMonitor(
                {
                    monitorGroup: group,
                    monitorMessages: groupMonitor.getMessages(
                        view.monitorJid,
                        20
                    )
                },
                { width, height }
            );
        }

        case "logs":
            return dashboard.renderLogs(
                {
                    logs: logger.getRecent({
                        level: view.logLevel,
                        limit: view.logLimit,
                        includeMessage: view.logLevel === "message"
                    })
                },
                { width, height }
            );

        case "help":
            return dashboard.renderHelp(
                { help: commands.getHelpCategories() },
                { width, height }
            );

        case "dashboard":
        default:
            return dashboard.renderDashboard(
                collectDashboard(),
                { width, height }
            );
    }
}

/* ---------------------------------------------------------
   Frame rendering (differential, anti-flicker)
   --------------------------------------------------------- */

function writeFrame(lines, height, full) {
    const width = getWidth();
    const paddedWidth = Math.max(1, width - 1);

    // Deteksi apakah ada yang perlu digambar. Jika tidak ada
    // perubahan, jangan sentuh layar sama sekali (anti flicker).
    let changed = Boolean(full) || lines.length !== lastLines.length;

    if (!changed) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i] !== lastLines[i]) {
                changed = true;
                break;
            }
        }
    }

    if (!changed) return;

    let out = ANSI.syncOn + ANSI.wrapOff + ANSI.hide;

    if (full) {
        out += ANSI.clear + ANSI.home;
    }

    for (let i = 0; i < lines.length; i++) {
        if (full || lines[i] !== lastLines[i]) {
            out += `\x1b[${i + 1};1H` + lines[i] + "\x1b[K";
        }
    }

    // Bersihkan baris sisa jika frame mengecil.
    if (lastLines.length > lines.length) {
        for (let i = lines.length; i < lastLines.length; i++) {
            out += `\x1b[${i + 1};1H\x1b[K`;
        }
    }

    out += ANSI.wrapOn;
    out += `\x1b[${height};1H`;
    out += ANSI.show + ANSI.syncOff;

    process.stdout.write(out);

    if (rl) {
        rl.prompt(true);
    }

    // Simpan referensi agar perbandingan berikutnya benar.
    lastWidth = paddedWidth;
    lastHeight = height;
}

// ============================================================
// DASHBOARD SECTION: REFRESH MECHANISM
// Menggambar ulang dashboard secara terkontrol (hanya baris
// yang berubah) supaya tidak flicker. Interval diatur oleh
// CONFIG.refreshInterval di config/joyConsole.js.
// ============================================================
function renderFrame(force) {
    if (!started) return;

    const width = getWidth();
    const height = getHeight();

    // Reserve baris terakhir untuk prompt.
    const contentHeight = Math.max(5, height - 1);

    let lines = buildViewLines(width, contentHeight);

    // Notice sementara (mis. hasil command).
    if (notice && Date.now() < noticeUntil) {
        lines = lines.slice(0, Math.max(0, contentHeight - 1));
        lines.push(dashboard.theme.muted("  " + notice));
    }

    lines = lines.slice(0, contentHeight);
    lines = lines.map((l) => padLine(l, width - 1));

    while (lines.length < contentHeight) {
        lines.push(" ".repeat(Math.max(1, width - 1)));
    }

    const dimensionChanged =
        width - 1 !== lastWidth || height !== lastHeight;

    writeFrame(
        lines,
        height,
        Boolean(force) || dimensionChanged || lastLines.length === 0
    );

    lastLines = lines;
}

function fullRedraw() {
    renderFrame(true);
}

/* ---------------------------------------------------------
   Command context
   --------------------------------------------------------- */

function resolveGroupByInput(input) {
    const groups = stats.getGroups();
    const value = String(input || "").trim();

    if (!value) return null;

    if (/^\d+$/.test(value)) {
        const index = Number(value) - 1;
        return groups[index] || null;
    }

    const lower = value.toLowerCase();

    return (
        groups.find((g) => g.jid === value) ||
        groups.find((g) => g.jid.toLowerCase().includes(lower)) ||
        groups.find(
            (g) =>
                g.name &&
                g.name.toLowerCase().includes(lower)
        ) ||
        null
    );
}

function openMonitor(input) {
    if (!input) {
        view.previous = view.current;
        view.current = "groups";
        stats.requestGroupNames();
        setNotice("Type the group number, or '/monitor <number|jid|name>'.", 6000);
        pending = { kind: "monitor-select" };
        fullRedraw();
        return;
    }

    const group = resolveGroupByInput(input);

    if (!group) {
        setNotice(`Group '${input}' not found. Use '/groups' to list.`);
        fullRedraw();
        return;
    }

    groupMonitor.open(group.jid);
    view.monitorJid = group.jid;
    view.previous = view.current;
    view.current = "monitor";
    setNotice(`Monitoring ${group.name || group.jid}.`, 5000);
    fullRedraw();
}

const ctx = {
    logger,
    stats,
    groupMonitor,
    activity,

    listGroups() {
        return stats.getGroups();
    },

    setView(name) {
        if (name === "groups") stats.requestGroupNames();
        view.previous = view.current;
        view.current = name;
        fullRedraw();
    },

    goHome() {
        view.previous = view.current;
        view.current = "dashboard";
        fullRedraw();
    },

    goBack() {
        const target =
            view.previous && view.previous !== view.current
                ? view.previous
                : "dashboard";

        view.previous = "dashboard";
        view.current = target;

        if (target === "groups") stats.requestGroupNames();

        fullRedraw();
    },

    clearScreen() {
        fullRedraw();
    },

    openUsers(query) {
        view.userQuery = String(query || "").trim();
        view.previous = view.current;
        view.current = "users";
        fullRedraw();

        if (!view.userQuery) {
            setNotice("Tip: '/users <name|id>' to search.", 5000);
            fullRedraw();
        }
    },

    openLogs(args) {
        const known = ["error", "warn", "info", "debug", "message"];
        const level = (args[0] || "").toLowerCase();

        if (known.includes(level)) {
            view.logLevel = level;
            const count = Number(args[1]);
            view.logLimit = Number.isFinite(count) && count > 0
                ? Math.min(count, 100)
                : 30;
        } else {
            view.logLevel = null;
            view.logLimit = 30;
        }

        view.previous = view.current;
        view.current = "logs";
        fullRedraw();
    },

    openMonitor,

    exitConsole() {
        teardownConsole(true);
    },

    beginPending(p) {
        pending = p;
    },

    openChat(input) {
        const group = resolveGroupByInput(input);
        if (!group) {
            setNotice(`Chat '${input}' not found. Use '/groups' to list.`);
            fullRedraw();
            return;
        }
        groupMonitor.open(group.jid);
        view.monitorJid = group.jid;
        view.previous = view.current;
        view.current = "monitor";
        setNotice(`Opened chat ${group.name || group.jid}.`, 5000);
        fullRedraw();
    },

    sendMessage(text) {
        if (!text) return;
        const active = groupMonitor.getActive();
        if (!active) {
            setNotice("No active chat. Use /openchat <group> first.");
            fullRedraw();
            return;
        }
        const socket = stats.getSocket();
        if (!socket || typeof socket.sendMessage !== "function") {
            setNotice("Socket not connected yet.");
            fullRedraw();
            return;
        }
        socket.sendMessage(active, { text }).catch((e) => {
            logger.log("warn", `Failed to send message: ${e.message}`);
        });
        setNotice("Message sent.", 3000);
        fullRedraw();
    }
};

/* ---------------------------------------------------------
   Input handling
   --------------------------------------------------------- */

function handleLine(line) {
    const trimmed = String(line || "").trim();

    // Kosong: gambar ulang penuh agar posisi layar selalu
    // kembali selaras setelah menekan Enter.
    if (!trimmed) {
        fullRedraw();
        return;
    }

    // Input lanjutan untuk command interaktif.
    if (pending) {
        const p = pending;
        pending = null;

        if (p.kind === "monitor-select") {
            openMonitor(trimmed);
            return;
        }
    }

    let message = null;

    try {
        message = commands.dispatch(ctx, trimmed);
    } catch (error) {
        message = `Command error: ${error.message}`;
        logger.log("error", `Console command error: ${error.stack || error.message}`);
    }

    if (message) setNotice(message);

    // Setelah command, lakukan full redraw agar prompt bersih
    // (Enter dapat menggeser layar; full redraw mengembalikan posisi).
    fullRedraw();
}

/* ---------------------------------------------------------
   Startup animation
   ============================================================
   DASHBOARD SECTION: STARTUP ANIMATION
   Animasi singkat saat console dibuka. Hanya berjalan di
   terminal interaktif. Tidak mengganggu koneksi WhatsApp.
   Nonaktifkan lewat CONFIG.startupAnimation = false.
   ============================================================
   --------------------------------------------------------- */

async function runStartupAnimation() {
    process.stdout.write(ANSI.clear + ANSI.home);

    if (bannerRenderer) {
        try {
            await bannerRenderer();
        } catch {}
    }

    const lines = [
        dashboard.theme.muted("  ──────────────────────────────────────"),
        "  " + dashboard.theme.accentBold("JOY UNIVERSE"),
        "  " + dashboard.theme.accentBold("JOY CONSOLE"),
        dashboard.theme.muted("  ──────────────────────────────────────")
    ];

    process.stdout.write("\n" + lines.join("\n") + "\n\n");

    await sleep(450);
}

/* ---------------------------------------------------------
   Lifecycle
   --------------------------------------------------------- */

function init() {
    if (initialized) return;
    initialized = true;

    logger.install();
    interactive = isInteractiveTerminal();
    logger.setFrameActive(false);
}

function setStartupBanner(fn) {
    if (typeof fn === "function") {
        bannerRenderer = fn;
    }
}

// Dipanggil dari showBanner() SEBELUM koneksi WhatsApp.
async function startup() {
    init();

    if (!interactive || !CONFIG.startupAnimation) {
        return;
    }

    await runStartupAnimation();
}

// Dipanggil setelah pairing selesai / listener terpasang.
function ready() {
    if (!CONFIG.enabled || !interactive || started) return;

    started = true;
    logger.setFrameActive(true);

    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: PROMPT,
        terminal: true
    });

    rl.on("line", handleLine);

    rl.on("SIGINT", () => {
        process.stdout.write("\n");

        // Utamakan graceful shutdown milik index.js (menutup
        // socket + melepas lock) agar session tidak tertinggal
        // dalam keadaan setengah tertulis.
        if (shutdownHandler) {
            Promise.resolve(shutdownHandler("SIGINT")).catch((error) => {
                logger.log(
                    "error",
                    `Shutdown error: ${error.message}`
                );
                shutdown();
                process.exit(1);
            });

            return;
        }

        shutdown();
        process.exit(0);
    });

    rl.on("close", () => {
        if (started) {
            teardownConsole(false);
        }
    });

    resizeHandler = () => {
        lastLines = [];
        lastWidth = -1;
        lastHeight = -1;
        fullRedraw();
    };

    process.stdout.on("resize", resizeHandler);

    // Render pertama.
    lastLines = [];
    fullRedraw();

    refreshTimer = setInterval(() => {
        try {
            renderFrame(false);
        } catch (error) {
            logger.log("error", `Dashboard render error: ${error.message}`);
        }
    }, Math.max(250, CONFIG.refreshInterval || 1000));
}

// Didaftarkan oleh index.js agar Ctrl+C menutup socket dulu.
function setShutdownHandler(fn) {
    shutdownHandler = typeof fn === "function" ? fn : null;
}

// Hentikan seluruh console (dipakai SIGINT).
function shutdown() {
    teardownConsole(false);
    try {
        activity.stop();
        logger.stop();
    } catch {}
}

// Tutup UI console; bot tetap berjalan kecuali exitProcess.
function teardownConsole(exitOnly) {
    if (tearingDown) return;
    tearingDown = true;

    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    if (resizeHandler) {
        process.stdout.removeListener("resize", resizeHandler);
        resizeHandler = null;
    }

    const currentRl = rl;
    rl = null;

    if (currentRl) {
        try {
            currentRl.removeAllListeners("line");
            currentRl.removeAllListeners("SIGINT");
            currentRl.removeAllListeners("close");
            currentRl.close();
        } catch {}
    }

    logger.setFrameActive(false);
    groupMonitor.close();

    try {
        activity.flush();
        logger.stop();
    } catch {}

    started = false;
    interactive = false;
    tearingDown = false;

    process.stdout.write(
        "\n" + dashboard.theme.muted(
            "Joy Console closed. Joybot keeps running. (Ctrl+C to stop the bot)"
        ) + "\n"
    );
}

/* ---------------------------------------------------------
   Hooks dari index.js
   --------------------------------------------------------- */

function attachSocket(Joy) {
    stats.setSocket(Joy);
}

function setConnection(status, update) {
    const map = {
        open: "CONNECTED",
        connecting: "CONNECTING",
        close: "DISCONNECTED"
    };

    const mapped = map[status] || "UNKNOWN";
    stats.setConnection(mapped);

    if (status === "close") {
        const reason =
            update?.lastDisconnect?.error?.message ||
            update?.lastDisconnect?.error?.output?.statusCode;

        logger.log(
            "warn",
            `WhatsApp connection closed${reason ? ` (${reason})` : ""}. Reconnecting...`
        );
    }

    if (status === "open") {
        logger.log("info", "WhatsApp connection opened.");
        stats.setHandlerStatus("READY");
    }
}

function recordError(error, context) {
    const message =
        error && error.stack ? error.stack : String(error);

    logger.log(
        "error",
        `${context ? `[${context}] ` : ""}${message}`
    );

    if (context === "messageHandler") {
        stats.setHandlerStatus("ERROR");
    }
}

function extractBody(msg) {
    const m = msg?.message || {};

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ""
    );
}

function getTimestampSeconds(msg) {
    const raw = msg?.messageTimestamp;

    const value =
        raw && typeof raw.toNumber === "function"
            ? raw.toNumber()
            : Number(raw);

    return Number.isFinite(value) ? value : null;
}

/* ============================================================
   ACTIVITY TRACKING
   Dipanggil dari event messages.upsert yang SUDAH ADA di
   index.js. Menggunakan id pesan yang stabil untuk mencegah
   penghitungan ganda saat reconnect / pesan diputar ulang.
   ============================================================ */
function recordMessage(msg) {
    try {
        if (!msg || !msg.key || !msg.key.id) return;

        const id = String(msg.key.id);

        if (seenIds.has(id)) return;

        seenIds.add(id);
        seenOrder.push(id);

        if (seenOrder.length > 5000) {
            const old = seenOrder.shift();
            seenIds.delete(old);
        }

        // Abaikan pesan lama (hasil sync history / replay reconnect)
        // agar tidak dihitung sebagai aktivitas baru.
        const ts = getTimestampSeconds(msg);

        if (
            ts !== null &&
            Date.now() / 1000 - ts > MAX_RECORD_AGE_SECONDS
        ) {
            return;
        }

        const fromMe = Boolean(msg.key.fromMe);
        const remote = msg.key.remoteJid || "";
        const isGroup = remote.endsWith("@g.us");

        const senderJid = msg.key.participant || remote;
        const senderId = String(senderJid)
            .split("@")[0]
            .split(":")[0];

        const name = msg.pushName || null;
        const body = extractBody(msg);

        if (isGroup) {
            activity.recordGroupMessage(
                remote,
                fromMe ? "outgoing" : "incoming"
            );
        }

        if (!fromMe) {
            activity.recordUser(senderId, name);

            if (
                body &&
                body.trim().startsWith(botConfig.prefix)
            ) {
                activity.recordCommand(senderId, name);
            }
        }

        activity.recordTotals({
            incoming: fromMe ? 0 : 1,
            outgoing: fromMe ? 1 : 0
        });

        if (isGroup) {
            groupMonitor.push({
                gid: remote,
                id,
                time: new Date().toISOString(),
                sender: name || senderId,
                senderId,
                body,
                direction: fromMe ? "outgoing" : "incoming"
            });
        }

        // Level "message" tidak tampil di dashboard utama,
        // tetapi tersedia lewat command 'logs message'.
        logger.log(
            "message",
            `${isGroup ? "[group]" : "[dm]"} ${
                name || senderId
            }: ${body || "(non-text)"}`
        );

        stats.setHandlerStatus("READY");
    } catch (error) {
        // Jangan pernah menghambat pemrosesan pesan.
        logger.log("warn", `Activity tracking failed: ${error.message}`);
    }
}

module.exports = {
    init,
    startup,
    ready,
    setStartupBanner,
    attachSocket,
    setConnection,
    recordMessage,
    recordError,
    setShutdownHandler,
    shutdown,
    // Untuk pengujian / pemakaian lanjutan:
    _internal: {
        renderFrame,
        isInteractiveTerminal,
        getState: () => ({
            interactive,
            started,
            view: { ...view }
        })
    }
};
