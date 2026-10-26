/* =========================================================
   JOYBOT SINGLE INSTANCE LOCK
   ---------------------------------------------------------
   useMultiFileAuthState() dari Baileys hanya mengunci file
   dalam SATU proses. Jika dua proses bot memakai folder
   sessions yang sama, keduanya bisa saling menimpa state
   Signal dan memicu error dekripsi.

   Lock ini hanya menjaga agar hanya satu proses Joybot yang
   boleh menyentuh folder auth. Lock TIDAK menghapus atau
   mengubah creds/session apa pun.
   ========================================================= */

const fs = require("fs");
const path = require("path");

const STALE_UNREADABLE_MS = 10000;

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM berarti proses ada tetapi bukan milik user ini.
        return error && error.code === "EPERM";
    }
}

function readLock(lockPath) {
    let stat = null;

    try {
        stat = fs.statSync(lockPath);
    } catch {
        return null;
    }

    try {
        const raw = fs.readFileSync(lockPath, "utf8").trim();

        if (!raw) {
            return {
                empty: true,
                mtimeMs: stat.mtimeMs
            };
        }

        const data = JSON.parse(raw);
        const pid = Number(data.pid);

        return {
            pid: Number.isInteger(pid) ? pid : null,
            startedAt: data.startedAt || null,
            mtimeMs: stat.mtimeMs
        };
    } catch {
        return {
            unreadable: true,
            mtimeMs: stat.mtimeMs
        };
    }
}

function isStaleLock(info) {
    if (!info) {
        return false;
    }

    if (info.pid) {
        return !isProcessAlive(info.pid);
    }

    // Lock kosong/rusak bisa terjadi jika proses lain baru
    // membuat file dan belum selesai menulis. Tunggu dulu.
    return Date.now() - info.mtimeMs > STALE_UNREADABLE_MS;
}

function quarantineStaleLock(lockPath) {
    const quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;

    try {
        // rename bersifat atomik: hanya satu proses yang berhasil
        // memindahkan lock lama, sehingga lock baru tidak ikut terhapus.
        fs.renameSync(lockPath, quarantinePath);
    } catch (error) {
        return error && error.code === "ENOENT";
    }

    try {
        fs.unlinkSync(quarantinePath);
    } catch {}

    return true;
}

function tryAcquire(lockPath) {
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });

        const fd = fs.openSync(lockPath, "wx");

        try {
            fs.writeFileSync(
                fd,
                JSON.stringify({
                    app: "Joybot",
                    pid: process.pid,
                    startedAt: new Date().toISOString()
                }) + "\n"
            );
        } finally {
            fs.closeSync(fd);
        }

        return { acquired: true };
    } catch (error) {
        if (!error || error.code !== "EEXIST") {
            throw error;
        }

        const existing = readLock(lockPath);

        return {
            acquired: false,
            existing,
            stale: isStaleLock(existing)
        };
    }
}

async function acquireInstanceLock({
    lockPath,
    timeoutMs = 10000,
    retryMs = 250
} = {}) {
    if (!lockPath) {
        throw new Error("lockPath wajib diisi");
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastExisting = null;

    for (;;) {
        const result = tryAcquire(lockPath);

        if (result.acquired) {
            return lockPath;
        }

        lastExisting = result.existing;

        if (result.stale && quarantineStaleLock(lockPath)) {
            continue;
        }

        if (Date.now() >= deadline) {
            const owner = lastExisting?.pid
                ? `PID ${lastExisting.pid}`
                : "proses lain";

            const error = new Error(
                `Joybot sudah berjalan (${owner}). ` +
                "Instans kedua dihentikan agar auth WhatsApp tidak rusak."
            );

            error.code = "JOYBOT_ALREADY_RUNNING";
            throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
}

function releaseInstanceLock(lockPath) {
    if (!lockPath) {
        return;
    }

    try {
        const existing = readLock(lockPath);

        if (existing?.pid && existing.pid !== process.pid) {
            return;
        }

        fs.unlinkSync(lockPath);
    } catch {}
}

module.exports = {
    acquireInstanceLock,
    releaseInstanceLock,
    isProcessAlive
};
