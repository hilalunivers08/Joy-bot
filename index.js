/* =========================================================
   JOY CONSOLE - LOGGING INTEGRATION
   ---------------------------------------------------------
   Seluruh output console.* Joybot (termasuk filter pesan sesi
   Baileys) kini ditangani oleh Joy Console:
   - disimpan ke file log + buffer memori
   - WARNING/ERROR tampil di dashboard
   - pesan masuk tidak membanjiri dashboard utama
   Implementasi logging ada di console/logger.js.
========================================================= */

const JoyConsole = require("./console");

JoyConsole.init();

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("baileys");

const {
  acquireInstanceLock,
  releaseInstanceLock
} = require("./utils/singleInstance");

const fs = require("fs");
const path = require("path");
const os = require("os");
const pino = require("pino");
const chalk = require("chalk");
const readline = require("readline");


// const originalConsoleLog = console.log.bind(console);

// console.log = (...args) => {
//     const message =
//         typeof args[0] === "string" ? args[0] : "";

//     const ignoredLogs = [
//         "Closing session:",
//         "Closing stale open session",
//         "Closing open session in favor of incoming prekey bundle",
//         "Removing old closed session:"
//     ];

//     if (
//         ignoredLogs.some((prefix) =>
//             message.startsWith(prefix)
//         )
//     ) {
//         return;
//     }

//     originalConsoleLog(...args);
// };

const messageHandler = require("./handlers/messageHandler");

const usePairingCode = true;


/* =========================================================
   JOYBOT CONFIG
========================================================= */

const BOT_NAME = "JOYBOT";
const BOT_VERSION = "v1.0.0";
const AUTHOR = "Hilal";
const AUTHOR_NUMBER = "222079890813069";

const PROJECT_ROOT = __dirname;

/* =========================================================
   WHATSAPP CONNECTION STATE
   ---------------------------------------------------------
   Hanya boleh ada SATU socket aktif dan SATU proses yang
   memakai folder auth. Ini mencegah state Signal saling
   menimpa saat reconnect / restart.
========================================================= */

const AUTH_DIR = path.join(PROJECT_ROOT, "sessions");
const INSTANCE_LOCK = path.join(AUTH_DIR, ".joybot.lock");

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const SENT_MESSAGE_CACHE_LIMIT = 256;

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connecting = false;
let shuttingDown = false;
let instanceLockPath = null;

// Dipakai untuk menjawab retry request WhatsApp (getMessage).
// Hanya isi pesan terakhir yang disimpan, bukan kredensial.
const sentMessageCache = new Map();

const SPINNER = [
  "◐",
  "◓",
  "◑",
  "◒"
];


/* =========================================================
   UTILITY
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


async function typeText(text, delay = 20) {
  for (const char of text) {
    process.stdout.write(char);
    await sleep(delay);
  }

  process.stdout.write("\n");
}


/* =========================================================
   PACKAGE INFORMATION
========================================================= */

function getPackageCount() {
  try {
    const packagePath = path.join(
      PROJECT_ROOT,
      "package.json"
    );

    if (!fs.existsSync(packagePath)) {
      return 0;
    }

    const packageJson = JSON.parse(
      fs.readFileSync(
        packagePath,
        "utf8"
      )
    );

    const dependencies = Object.keys(
      packageJson.dependencies || {}
    );

    const devDependencies = Object.keys(
      packageJson.devDependencies || {}
    );

    return new Set([
      ...dependencies,
      ...devDependencies
    ]).size;

  } catch (error) {
    return 0;
  }
}


/* =========================================================
   GET INSTALLED PACKAGE VERSION
========================================================= */

function getPackageVersion(packageName) {
  try {
    const packagePath = path.join(
      PROJECT_ROOT,
      "node_modules",
      packageName,
      "package.json"
    );

    if (!fs.existsSync(packagePath)) {
      return "Unknown";
    }

    const packageJson = JSON.parse(
      fs.readFileSync(
        packagePath,
        "utf8"
      )
    );

    return packageJson.version || "Unknown";

  } catch (error) {
    return "Unknown";
  }
}


/* =========================================================
   FIND JAVASCRIPT FILES
========================================================= */

function getJSFiles(directory) {
  let files = [];

  if (!fs.existsSync(directory)) {
    return files;
  }

  const entries = fs.readdirSync(
    directory,
    {
      withFileTypes: true
    }
  );

  for (const entry of entries) {
    const fullPath = path.join(
      directory,
      entry.name
    );

    if (entry.isDirectory()) {

      if (
        entry.name === "node_modules" ||
        entry.name === "sessions" ||
        entry.name === ".git"
      ) {
        continue;
      }

      files = files.concat(
        getJSFiles(fullPath)
      );
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".js")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}


/* =========================================================
   COUNT LINES OF CODE
========================================================= */

function countCodeLines(filePath) {
  try {
    const content = fs.readFileSync(
      filePath,
      "utf8"
    );

    const lines = content.split(
      /\r?\n/
    );

    let count = 0;
    let insideBlockComment = false;

    for (let line of lines) {

      line = line.trim();

      // Baris kosong
      if (!line) {
        continue;
      }

      // Sedang berada di dalam block comment
      if (insideBlockComment) {

        if (line.includes("*/")) {
          insideBlockComment = false;
        }

        continue;
      }

      // Block comment
      if (line.startsWith("/*")) {

        if (!line.includes("*/")) {
          insideBlockComment = true;
        }

        continue;
      }

      // Single line comment
      if (
        line.startsWith("//") ||
        line.startsWith("*")
      ) {
        continue;
      }

      count++;
    }

    return count;

  } catch (error) {
    return 0;
  }
}


/* =========================================================
   SOURCE STATISTICS
========================================================= */

function getSourceStats() {
  const files = getJSFiles(
    PROJECT_ROOT
  );

  let totalLines = 0;

  for (const file of files) {
    totalLines += countCodeLines(
      file
    );
  }

  return {
    files: files.length,
    lines: totalLines
  };
}


/* =========================================================
   MEMORY
========================================================= */

function getMemoryUsage() {
  const memory =
    process.memoryUsage().rss;

  return `${Math.round(
    memory / 1024 / 1024
  )} MB`;
}


/* =========================================================
   FOLDER STRUCTURE
========================================================= */

function getProjectFolders() {

  const folders = [
    "commands",
    "database",
    "config",
    "handlers",
    "utils"
  ];

  const result = [];

  for (const folder of folders) {

    const folderPath =
      path.join(
        PROJECT_ROOT,
        folder
      );

    if (fs.existsSync(folderPath)) {
      result.push(folder);
    }
  }

  if (
    fs.existsSync(
      path.join(
        PROJECT_ROOT,
        "index.js"
      )
    )
  ) {
    result.push("index.js");
  }

  return result;
}


/* =========================================================
   SYSTEM INFORMATION
========================================================= */

function getSystemInfo() {

  const source =
    getSourceStats();

  return {

    packages:
      getPackageCount(),

    sourceFiles:
      source.files,

    lines:
      source.lines,

    platform:
      os.platform(),

    architecture:
      os.arch(),

    node:
      process.version,

    baileys:
      getPackageVersion(
        "baileys"
      ),

    memory:
      getMemoryUsage(),

    folders:
      getProjectFolders()
  };
}


/* =========================================================
   JOY ASCII LOGO
========================================================= */

const LOGO_ART = [

  "   +====-                                             -==****=",

  "  =+*****+=+                                        =-***++*+=",

  "   *********==                                     -**+**+*+*+",

  "   =****+*+***+=                                 =*++**++*++=",

  "   +******+++*+#*=                             =+*++++*+**++*=",

  "    +***+***#*++***=                         -=*+******+++*++",

  "     *#***+*##****+**=                       =+*+********++**=",

  "     +**#+*+#****#+*+**=*      :--:      -=*++++****+**+**++=",

  "     -***#**#*##*##+++++=-=+:-:==*=-:-=--=+++**#+***+*****+=",

  "      +#*****##+#*#***++++=====++*+-===+=====*****#*+*****=+-",

  "      -+*******#*##*+*++=++===++*%*+=++=++==++***##**++***+==",

  "       ++#**+***#**++*+++++++=++#%%**++=*=++==++++*-=+*+***++",

  "       +******#**#++**=**+=*#*=##%%%%#*++*==+=+=+++++*=****=+",

  "      -+*#****+*+**+++*+*++*##+*#@%%%#++*#*++++=+++++++***++",

  "        +###***++****#*##++##%*#%@@@@%**#%##***++=+++++**+-",

  "         +*#***+++**+++*#%%%%%%%@@@@@%@@%+=++=+**===+++++==",

  "         =+*+*+*+**+====+-%%@@%@@@@@@%%*+=--=+:+*++=-=++=+=",

  "         =+++====+*=-:..++-%%@%@@@@%%%#=+-:.-==+#+-=-==+=--",

  "         :=====+#%*+=--+++=*%@%@@%%%%%+=++===+=*##+=---=--",

  "         ---===+#%%*-+++=*++%%%%%%%#%#++:====+*%%*+++----",

  "           -==+++*%%%%@%@%**%########%#%%@%%%%%*++*=+-",

  "            ==+****#@@@@@@%%########*##%%@@@%%%#*+**++",

  "             ==**###%@%@@@%%#*####*#*%%%%@%%%##****+==",

  "              =+****##%%%@@@*++****++#@%@%%%***++*==",

  "              *++*+#*#%%%%%%%##++++##%%%%%%%#+*#+*=-"

];


/* =========================================================
   FASTFETCH BANNER
========================================================= */

async function renderLogoWithText() {

  const info =
    getSystemInfo();

  const folders =
    info.folders;

  const bannerText = [

    chalk.cyan(
      "Author        : "
    ) +
    chalk.white(
      AUTHOR
    ),

    chalk.cyan(
      "Version       : "
    ) +
    chalk.white(
      BOT_VERSION
    ),

    chalk.cyan(
      "Node.js       : "
    ) +
    chalk.white(
      info.node
    ),

    chalk.cyan(
      "Baileys       : "
    ) +
    chalk.white(
      info.baileys
    ),

    "",

    chalk.cyan(
      "Platform      : "
    ) +
    chalk.white(
      info.platform
    ),

    chalk.cyan(
      "Architecture  : "
    ) +
    chalk.white(
      info.architecture
    ),

    chalk.cyan(
      "Memory        : "
    ) +
    chalk.white(
      info.memory
    ),

    "",

    chalk.cyan(
      "Packages      : "
    ) +
    chalk.yellow(
      info.packages
    ),

    chalk.cyan(
      "Source Files  : "
    ) +
    chalk.yellow(
      info.sourceFiles
    ),

    chalk.cyan(
      "Lines of Code : "
    ) +
    chalk.yellow(
      info.lines.toLocaleString()
    ),

    "",

    chalk.cyan.bold(
      "Project Structure"
    ),

    ...folders.map(
      (folder, index) => {

        const last =
          index ===
          folders.length - 1;

        return (
          chalk.gray(
            last
              ? "└── "
              : "├── "
          ) +
          chalk.white(folder)
        );
      }
    )
  ];


  const textStart = 70;


  for (
    let i = 0;
    i < LOGO_ART.length;
    i++
  ) {

    const line =
      chalk.cyan(
        LOGO_ART[i]
      );

    const spacing =
      " ".repeat(
        Math.max(
          1,
          textStart -
          LOGO_ART[i].length
        )
      );

    process.stdout.write(
      line +
      spacing +
      (
        bannerText[i] ||
        ""
      ) +
      "\n"
    );

    // Animasi banner seperti kode kamu
    await sleep(40);
  }
}


/* =========================================================
   LOADING SPINNER
========================================================= */

async function loadingStep(
  text
) {

  for (
    let i = 0;
    i < 8;
    i++
  ) {

    const spinner =
      SPINNER[
        i % SPINNER.length
      ];

    process.stdout.write(
      `\r${chalk.cyan(spinner)} ${chalk.white(text)}`
    );

    await sleep(45);
  }

  process.stdout.write(
    `\r${chalk.green("✓")} ${chalk.white(text)}\n`
  );
}


/* =========================================================
   SYSTEM STATUS
========================================================= */

// async function showSystemStatus() {

//   console.log(
//     chalk.cyan(
//       "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
//     )
//   );

//   await sleep(150);


//   const systems = [

//     "Initializing...",

//     "Loading configuration...",

//     "Loading command handler...",

//     "Loading database...",

//     "Loading AI engine..."

//   ];


//   for (
//     const system of systems
//   ) {

//     await loadingStep(
//       system
//     );

//     await sleep(80);
//   }


//   console.log("");


//   const modules = [

//     "AI SYSTEM",

//     "GAME SYSTEM",

//     "MEDIA SYSTEM",

//     "DOWNLOADER"

//   ];


//   for (
//     const module of modules
//   ) {

//     await typeText(
//       chalk.green(
//         `  [ ✓ ] ${module}`
//       ),
//       10
//     );

//     await sleep(20);
//   }


//   console.log(
//     chalk.cyan(
//       "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
//     )
//   );


//   await sleep(100);


//   await typeText(
//     chalk.yellow(
//       "  [ WHATSAPP ] Connecting..."
//     ),
//     20
//   );


//   await sleep(100);
// }


/* =========================================================
   SHOW BANNER
========================================================= */

async function showBanner() {
    // Ambil lock SEBELUM menyentuh folder auth. Jika terminal lama
    // masih hidup, proses baru menunggu (khusus restart) atau berhenti.
    const lockTimeout = Number(process.env.JOYBOT_RESTART_WAIT) || 10000;

    try {
        instanceLockPath = await acquireInstanceLock({
            lockPath: INSTANCE_LOCK,
            timeoutMs: lockTimeout
        });
    } catch (error) {
        console.error(chalk.red(`\n${error.message}`));
        process.exit(1);
    }

    registerShutdownHandlers();

    JoyConsole.setShutdownHandler?.(() => gracefulShutdown("SIGINT"));
    JoyConsole.setStartupBanner(renderLogoWithText);
    await JoyConsole.startup();
    await connectToWhatsApp();
}

showBanner().catch((error) => {
    console.error("Startup failed:", error);
    JoyConsole.recordError?.(error, "startup");
    scheduleReconnect("startup failure");
});


/* =========================================================
   PHONE NUMBER INPUT
========================================================= */

async function question(prompt) {

  process.stdout.write(
    prompt
  );

  const rl =
    readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });


  return new Promise(
    (resolve) => {

      rl.question(
        "",
        (answer) => {

          rl.close();

          resolve(answer);
        }
      );

    }
  );
}


/* =========================================================
   WHATSAPP CONNECTION HELPERS
========================================================= */

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}


function rememberSentMessage(trackingKey, message) {
  if (!trackingKey || !message) {
    return;
  }

  sentMessageCache.set(trackingKey, message);

  while (sentMessageCache.size > SENT_MESSAGE_CACHE_LIMIT) {
    const oldestKey = sentMessageCache.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    sentMessageCache.delete(oldestKey);
  }
}


async function closeActiveSocket() {
  const socket = activeSocket;
  activeSocket = null;

  if (!socket) {
    return;
  }

  try {
    await new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(finish, 5000);

      if (typeof timer.unref === "function") {
        timer.unref();
      }

      Promise.resolve()
        .then(() => socket.end(undefined))
        .then(finish, (error) => {
          console.error(
            "Gagal menutup socket WhatsApp:",
            error.message
          );

          finish();
        });
    });
  } catch (error) {
    console.error(
      "Gagal menutup socket WhatsApp:",
      error.message
    );
  }
}


function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  const attempt = Math.min(reconnectAttempts, 5);

  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * (2 ** attempt)
  ) + Math.floor(Math.random() * 500);

  reconnectAttempts += 1;

  console.log(
    chalk.yellow(
      `Reconnect attempt ${reconnectAttempts} in ${delay} ms (${reason})`
    )
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    connectToWhatsApp().catch((error) => {
      console.error("Reconnect failed:", error);
      JoyConsole.recordError?.(error, "reconnect");
      scheduleReconnect("reconnect failed");
    });
  }, delay);
}


async function gracefulShutdown(signal = "shutdown") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearReconnectTimer();

  console.log(
    chalk.yellow(`\nMenutup Joybot (${signal})...`)
  );

  await closeActiveSocket();

  try {
    JoyConsole.shutdown?.();
  } catch (error) {
    console.error(
      "Console shutdown error:",
      error.message
    );
  }

  releaseInstanceLock(instanceLockPath || undefined);
  instanceLockPath = null;

  process.exit(0);
}


function registerShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.once(signal, () => {
        gracefulShutdown(signal);
      });
    } catch {}
  }

  // process.exit() tetap melepas lock (mis. dari command restart).
  process.once("exit", () => {
    releaseInstanceLock(instanceLockPath || undefined);
  });
}


/* =========================================================
   WHATSAPP CONNECTION
========================================================= */

async function connectToWhatsApp() {
  if (shuttingDown || connecting) {
    return;
  }

  connecting = true;

  try {
    // Jangan pernah membuat socket baru di atas socket lama.
    // Jika reconnect dipanggil saat socket sebelumnya masih ada,
    // tutup dulu agar hanya satu socket yang menulis ke auth.
    if (activeSocket) {
      await closeActiveSocket();
    }

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);


    let version;
    let isLatest = false;

    try {
      const latest = await fetchLatestBaileysVersion();

      version = latest.version;
      isLatest = latest.isLatest;

      console.log(
        `Using WhatsApp V${version.join(".")}, isLatest: ${isLatest}`
      );
    } catch (error) {
      console.warn(
        "Gagal mengambil versi WhatsApp terbaru, memakai versi default Baileys:",
        error.message
      );
    }


    const socketConfig = {

      logger:
        pino({
          level: "silent"
        }),

      printQRInTerminal:
        !usePairingCode,

      auth:
        state,

      browser: [
        "Ubuntu",
        "Chrome",
        "20.0.04"
      ],

      syncFullHistory:
        true,

      generateHighQualityLinkPreview:
        true,

      getMessage: async (key) => {
        if (!key?.id) {
          return undefined;
        }

        const cacheKey = `${key.remoteJid || ""}:${key.id}`;
        return sentMessageCache.get(cacheKey)?.message;
      }

    };

    if (version) {
      socketConfig.version = version;
    }


    const Joy = makeWASocket(socketConfig);

    activeSocket = Joy;

    Joy.sentMessages = new Set();
    Joy.sentMessageKeys = new Map();


    // WAJIB dipasang sebelum requestPairingCode agar creds
    // hasil pairing tidak hilang ketika proses selesai.
    Joy.ev.on("creds.update", saveCreds);


    const originalSendMessage =
      Joy.sendMessage.bind(Joy);

    Joy.sendMessage = async (...args) => {
      const result = await originalSendMessage(...args);

      const content = args[1];

      const isDeleteMessage =
        content &&
        typeof content === "object" &&
        Boolean(content.delete);


      const sentText = content?.text;

      if (
        typeof sentText === "string" &&
        sentText.trim()
      ) {
        console.log(
          chalk.green.bold("[BOT]"),
          chalk.green.bold(BOT_NAME),
          chalk.gray(" : "),
          chalk.white(sentText)
        );
      }


      if (result?.key?.id && !isDeleteMessage) {
        const chatId =
          result.key.remoteJid || args[0];

        const trackingKey =
          `${chatId}:${result.key.id}`;

        Joy.sentMessages.add(trackingKey);
        Joy.sentMessageKeys.set(
          trackingKey,
          result.key
        );

        rememberSentMessage(
          trackingKey,
          result.message || content
        );
      }


      return result;
    };


    // Dipakai command restart agar socket ditutup rapi
    // sebelum proses lama keluar.
    Joy.stop = async () => {
      await closeActiveSocket();
    };


    /* =======================================================
       JOY CONSOLE ATTACH
       Memberi tahu Joy Console socket yang sedang aktif.
       TIDAK membuat koneksi WhatsApp baru.
    ======================================================= */

    JoyConsole.attachSocket(Joy);

    /* =======================================================
       CONNECTION
    ======================================================= */

    Joy.ev.on(
      "connection.update",
      (update) => {

        const {
          connection
        } = update;

        // Abaikan SEMUA event dari socket lama. Tanpa guard ini,
        // reconnect bisa membuat beberapa socket aktif yang
        // menulis ke folder auth yang sama, dan status console
        // bisa tertimpa oleh socket yang sudah ditutup.
        if (Joy !== activeSocket) {
          return;
        }

        // Joy Console: perbarui status koneksi WhatsApp.
        JoyConsole.setConnection(connection, update);


        if (
          connection === "close"
        ) {

          activeSocket = null;

          if (shuttingDown) {
            return;
          }

          const statusCode =
            update.lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          const reason =
            update.lastDisconnect
              ?.error
              ?.message ||
            String(statusCode || "unknown");

          console.log(
            chalk.red(
              `\n❌ Connection Lost (${reason}), scheduling reconnect`
            )
          );


          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.error(
              chalk.red(
                "WhatsApp logged out. Joybot tidak reconnect otomatis dan TIDAK menghapus session. Pairing ulang harus dilakukan manual."
              )
            );

            return;
          }


          scheduleReconnect(reason);

        }


        if (
          connection === "open"
        ) {

          clearReconnectTimer();
          reconnectAttempts = 0;

          console.log(
            chalk.cyan(
              "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            )
          );


          console.log(
            chalk.green.bold(
              "O N L I N E"
            )
          );


          console.log(
            chalk.gray(
              "Waiting for messages..."
            )
          );


          console.log(
            chalk.cyan(
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            )
          );

        }

      }
    );


  /* =======================================================
     MESSAGE HANDLER
  ======================================================= */

  Joy.ev.on(
    "messages.upsert",
    async (m) => {

      const msg =
        m.messages[0];


      if (
        !msg?.message
      ) {
        return;
      }

      // Joy Console: catat aktivitas pesan (tidak menghambat proses).
      // Dedupe berdasarkan id pesan ada di console/index.js.
      JoyConsole.recordMessage(msg);


      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";


      const pushname = msg.pushName || "Unknown";

      const senderJid =
          msg.key.participant || msg.key.remoteJid || "";

      const senderNumber = String(senderJid)
          .split("@")[0]
          .split(":")[0];

      if (!msg.key.fromMe) {
          const isAuthorMessage =
              senderNumber === AUTHOR_NUMBER;

          const roleLabel = isAuthorMessage
              ? chalk.magenta.bold("[AUTHOR]")
              : chalk.cyan("[USER]");

          const coloredName = isAuthorMessage
              ? chalk.magenta.bold(pushname)
              : chalk.cyan(pushname);

          console.log(
              roleLabel,
              coloredName,
              chalk.gray(" : "),
              chalk.white(body)
          );
      }


      try {

        await messageHandler(
          Joy,
          m
        );

      } catch (error) {

        console.error(
          "Handler Error:",
          error
        );

        // Joy Console: simpan error handler + tandai status ERROR.
        JoyConsole.recordError(error, "messageHandler");

      }

    }
  );


    // Socket sudah terpasang. Reconnect tetap boleh berjalan
    // walaupun pairing code sedang menunggu input.
    connecting = false;


    /* =======================================================
       PAIRING CODE
    ======================================================= */

    if (
      usePairingCode &&
      !state.creds.registered
    ) {

      try {

        const phoneNumber =
          await question(
            "Enter Phone Number (62) :\n"
          );


        const code =
          await Joy.requestPairingCode(
            phoneNumber.trim()
          );


        console.log(
          `Pairing Code : ${code}`
        );


      } catch (error) {

        console.error(
          "Failed to get pairing code:",
          error
        );

      }
    }


    // Joy Console: mulai dashboard + prompt setelah semua
    // listener terpasang dan pairing (jika ada) selesai.
    try {
      JoyConsole.ready();
    } catch (error) {
      console.error(
        "Gagal memulai Joy Console:",
        error.message
      );
    }

  } catch (error) {
    connecting = false;

    // Jangan tinggalkan socket setengah jadi yang masih bisa
    // menulis ke folder auth saat reconnect berikutnya.
    await closeActiveSocket();

    console.error(
      "Gagal membuat koneksi WhatsApp:",
      error
    );

    JoyConsole.recordError?.(error, "connectToWhatsApp");
    scheduleReconnect("gagal membuat socket");
  }
}


/* =========================================================
   START JOYBOT
========================================================= */

// showBanner().then(() => {

//   connectToWhatsApp();

// });