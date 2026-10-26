/* =========================================================
   JOY CONSOLE CONFIGURATION
   ---------------------------------------------------------
   File ini HANYA untuk mengatur tampilan Joy Console.
   Jangan menaruh API key, nomor, atau kredensial WhatsApp
   di sini. Kredensial tetap berada di api.env / sessions.

   Semua nilai di bawah ini punya default yang aman.
   ========================================================= */

module.exports = {

    // Aktifkan / matikan seluruh Joy Console.
    // Jika false, Joybot berjalan seperti biasa tanpa dashboard.
    enabled: false,

    // Warna aksen utama Joy Console (nama warna chalk).
    // Contoh lain: "cyan", "magenta", "blue", "yellow".
    accentColor: "green",

    // Interval refresh dashboard dalam milidetik.
    refreshInterval: 1000,

    // Mode interaktif:
    //   "auto"  -> dashboard aktif hanya jika terminal TTY + mendukung ANSI
    //   true    -> paksa aktif
    //   false   -> paksa nonaktif (log polos ke terminal)
    interactive: "auto",

    // Tampilkan animasi startup singkat saat console pertama dibuka.
    startupAnimation: false,

    // =========================================================
    // LOGGING
    // ---------------------------------------------------------
    // Simpan log penting ke file dan sediakan buffer di memori.
    // =========================================================
    log: {
        // Lokasi file log. Folder "logs/" sudah diabaikan Git.
        file: "logs/joybot.log",

        // Rotasi: ukuran maksimum satu file (byte) dan jumlah file lama.
        maxBytes: 2 * 1024 * 1024,
        maxFiles: 3,

        // Jumlah entri log yang disimpan di memori untuk tampilan.
        bufferSize: 500,

        // Level minimum yang muncul pada pane log dashboard.
        // Nilai: "error", "warn", "info", "debug", "message".
        dashboardLevel: "warn",

        // Tulis log pesan masuk/keluar (level "message") ke file juga?
        persistMessages: true
    },

    // =========================================================
    // ACTIVITY TRACKING
    // ---------------------------------------------------------
    // Pencatatan aktivitas pengguna & grup (persisten).
    // =========================================================
    activity: {
        file: "database/activity.json",
        // Selang penyimpanan ke disk (ms). Tidak menulis tiap pesan.
        saveInterval: 5000
    },

    // File aset logo kucing (berisi LOGO_ART asli, tanpa perubahan).
    logoFile: "database/console-logo.json",

    // =========================================================
    // LAYOUT
    // ---------------------------------------------------------
    // Atur bagian yang tampil. Ubah angka untuk membatasi baris.
    // =========================================================
    layout: {
        // Tampilkan logo kucing pada header (jika terminal cukup tinggi).
        showLogo: true,
        // Baris maksimum untuk daftar pada tiap tampilan.
        maxUserRows: 15,
        maxGroupRows: 15,
        maxLogRows: 10,
        // Tampilkan pane log pada dashboard utama.
        showLogPane: false,
        // Tampilkan pane ringkasan grup pada dashboard utama.
        showGroupSummary: false
    }
};
