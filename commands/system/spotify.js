"use strict";

const controller = require("../../services/spotifyController");
const { SpotifyError } = require("../../services/spotifyController");

let commandQueue = Promise.resolve();

function sendReply(sock, msg, text) {
  return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

function enqueue(task) {
  const run = commandQueue.then(task, task);
  commandQueue = run.catch(() => {});
  return run;
}

function formatStatus(status) {
  const title = status.title || "Tidak diketahui";
  const artist = status.artist || "Tidak diketahui";
  const position = status.position || "Tidak diketahui";
  const duration = status.duration || "Tidak diketahui";
  const state =
    status.state === "playing"
      ? "Playing"
      : status.state === "paused"
        ? "Paused"
        : status.state || "Tidak diketahui";

  return [
    "🎧 SPOTIFY STATUS",
    `🎵 Lagu: ${title}`,
    `👤 Artis: ${artist}`,
    `⏱️ Posisi: ${position} / ${duration}`,
    `▶️ Status: ${state}`
  ].join("\n");
}

function getErrorMessage(error) {
  if (error instanceof SpotifyError) {
    if (error.code === "CDP_UNREACHABLE" || error.code === "CDP_CONNECT_FAILED") {
      return (
        "❌ Tidak terhubung ke Brave dengan CDP.\n\n" +
        "Jalankan: scripts\\start-brave-spotify.bat\n" +
        "Pastikan Brave tetap terbuka dan mengarah ke https://open.spotify.com\n" +
        "CDP hanya boleh di 127.0.0.1 (localhost)."
      );
    }

    if (error.code === "NOT_LOGGED_IN") {
      return (
        "❌ Spotify Web belum login.\n\n" +
        "Login di tab Spotify pada Brave yang dijalankan lewat start-brave-spotify.bat.\n" +
        "Gunakan profil khusus, jangan profil Brave normal.\n" +
        "Setelah login, kirim ulang perintah."
      );
    }

    if (error.code === "NO_RESULTS") {
      return `❌ ${error.message}`;
    }

    if (error.code === "PLAYBACK_UNVERIFIED" || error.code === "PLAYBACK_STATE_UNVERIFIED") {
      return (
        "⚠️ Perintah dijalankan, tetapi pemutaran tidak berhasil diverifikasi.\n\n" +
        `${error.message}\n\n` +
        "Bot tidak melaporkan sukses karena verifikasi gagal."
      );
    }

    return `❌ ${error.message}`;
  }

  if (error && error.message) {
    return `❌ Gagal mengontrol Spotify: ${error.message}`;
  }

  return "❌ Gagal mengontrol Spotify.";
}

async function executeCommand(sock, msg, args, command) {
  const raw = String(command || (args && args[0]) || "")
    .toLowerCase()
    .trim();

  const action = {
    n: "next",
    pre: "prev"
  }[raw] || raw;

  try {
    switch (action) {
      case "spotatus": {
        const status = await controller.getPlaybackStatus();
        await sendReply(sock, msg, formatStatus(status));
        break;
      }

      case "pause": {
        const result = await controller.pause();

        if (result.alreadyPaused) {
          await sendReply(sock, msg, "⏸️ Spotify sudah dijeda.");
        } else {
          await sendReply(sock, msg, "⏸️ Spotify dijeda.");
        }

        break;
      }

      case "next": {
        await controller.next();
        await sendReply(sock, msg, "⏭️ Beralih ke lagu berikutnya.");
        break;
      }

      case "prev":
      case "previous": {
        await controller.previous();
        await sendReply(sock, msg, "⏮️ Kembali ke lagu sebelumnya.");
        break;
      }

      case "play": {
        const query = args.join(" ").trim();

        // .play tanpa argumen = lanjutkan pemutaran
        if (!query) {
          const result = await controller.play();

          if (result.alreadyPlaying) {
            await sendReply(
              sock,
              msg,
              "🎵 Spotify sedang memutar lagu.\n" +
                "Gunakan .play judul lagu untuk mencari lagu lain."
            );
          } else {
            await sendReply(sock, msg, "▶️ Melanjutkan pemutaran Spotify.");
          }

          break;
        }

        const lower = query.toLowerCase();

        if (/^playlist\s+/i.test(query)) {
          const playlistName = query.replace(/^playlist\s+/i, "").trim();

          if (!playlistName) {
            await sendReply(sock, msg, "❌ Nama playlist belum diberikan.");
            break;
          }

          await sendReply(
            sock,
            msg,
            `🔎 Mencari playlist di Spotify: ${playlistName}`
          );

          const result = await controller.playPlaylist(playlistName);

          const playlistTitle =
            result.selected?.title || playlistName;
          const trackTitle = result.status?.title;

          if (trackTitle) {
            await sendReply(
              sock,
              msg,
              `▶️ Memutar playlist: ${playlistTitle}\n🎵 Sekarang: ${trackTitle}`
            );
          } else {
            await sendReply(
              sock,
              msg,
              `▶️ Memutar playlist: ${playlistTitle}`
            );
          }

          break;
        }

        await sendReply(sock, msg, `🔎 Mencari di Spotify: ${query}`);

        const result = await controller.playTrack(query);
        const trackTitle = result.status?.title || result.selected?.title;

        if (trackTitle) {
          await sendReply(sock, msg, `▶️ Memutar: ${trackTitle}`);
        } else {
          await sendReply(sock, msg, `▶️ Memutar: ${query}`);
        }

        break;
      }

      default: {
        await sendReply(
          sock,
          msg,
          "🎧 PERINTAH SPOTIFY\n\n" +
            ".play judul lagu\n" +
            ".play judul lagu artist nama artis\n" +
            ".play playlist nama playlist\n" +
            ".pause\n" +
            ".next / .n\n" +
            ".prev / .pre / .previous\n" +
            ".spotatus"
        );
      }
    }
  } catch (error) {
    console.error("[SPOTIFY ERROR]", error);
    await sendReply(sock, msg, getErrorMessage(error));
  }
}

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
    "spotatus"
  ],
  category: "system",
  description: "Mengontrol Spotify Web melalui Brave (CDP)",

  execute(sock, msg, args, command) {
    return enqueue(() => executeCommand(sock, msg, args, command));
  }
};
