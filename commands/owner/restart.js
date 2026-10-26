const { spawn } = require("child_process");

module.exports = async (
    Joy,
    msg,
    reply
) => {
    const entryArgs = process.argv.slice(1);

    if (!entryArgs.length) {
        return reply(
            "Restart gagal: entry point tidak ditemukan."
        );
    }

    const child = spawn(
        process.execPath,
        entryArgs,
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                // Beri waktu proses lama menutup socket + melepas
                // lock auth sebelum proses baru mulai.
                JOYBOT_RESTART_WAIT: "60000"
            },
            detached: true,
            stdio: "inherit",
            windowsHide: false
        }
    );

    child.once("error", async (error) => {
        console.error("Restart gagal:", error.message);

        try {
            await reply("Restart gagal dijalankan.");
        } catch {}
    });

    child.once("spawn", async () => {
        child.unref();

        try {
            await reply("Joybot sedang dimulai ulang...");
        } catch (error) {
            console.error(
                "Gagal mengirim pesan restart:",
                error.message
            );
        }

        // Tutup socket dengan rapi sebelum keluar. Proses baru
        // sudah menunggu lock, jadi tidak ada dua socket aktif.
        try {
            await Joy.stop?.();
        } catch (error) {
            console.error(
                "Gagal menutup socket saat restart:",
                error.message
            );
        }

        process.exit(0);
    });
};