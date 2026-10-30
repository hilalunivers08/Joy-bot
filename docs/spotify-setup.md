# Spotify Web Controller untuk Joy Bot (Windows + Brave + CDP)

Dokumentasi ini menjelaskan cara menghubungkan Joy Bot ke **Spotify Web Player** melalui **Brave Browser** memakai **Chrome DevTools Protocol (CDP)**.

Controller terinspirasi dari [spotify-controls-api](https://github.com/simonbs/spotify-controls-api), namun diimplementasikan untuk **Windows + Playwright + Spotify Web** (bukan AppleScript/macOS).

## 1. Arsitektur

File yang terlibat:

- `services/spotifyController.js` - Service reusable (attach ke Brave via CDP, cari tab Spotify, cari/putar lagu/playlist, verifikasi playback)
- `commands/system/spotify.js` - Command WhatsApp untuk Joy Bot
- `handlers/messageHandler.js` - Dispatch command (sudah terintegrasi)
- `scripts/start-brave-spotify.bat` - Script aman untuk menjalankan Brave dengan CDP

Semua perintah di-serialize (command queue) agar navigasi Spotify tidak bertabrakan.

## 2. Keamanan

- **Hanya localhost**: Script menggunakan `--remote-debugging-address=127.0.0.1`. Jangan ubah ke `0.0.0.0`.
- **Profil khusus**: Script menggunakan profil terpisah (`Brave-Browser-Spotify-Automation`) secara default. **Jangan pakai profil normal Brave kamu**.
- **Tidak menyimpan credential**: Controller tidak membaca/menyimpan cookies, token, atau kredensial Spotify.
- **Tidak menutup browser**: Saat command selesai, Brave tetap terbuka.
- **Tidak fallback diam-diam**: Controller TIDAK membuka browser terpisah dengan `launchPersistentContext()`. Hanya attach via CDP.
- **Tidak paksa menutup proses**: Script tidak membunuh proses Brave yang sedang berjalan.

## 3. Konfigurasi `.env` (opsional)

Tambahkan ke `.env` jika perlu menyesuaikan:

```env
SPOTIFY_CDP_URL=http://127.0.0.1:9222
SPOTIFY_BRAVE_PATH=
SPOTIFY_BRAVE_USER_DATA_DIR=
SPOTIFY_CDP_TIMEOUT=15000
SPOTIFY_NAVIGATION_TIMEOUT=45000
SPOTIFY_VERIFY_TIMEOUT=20000
```

- `SPOTIFY_CDP_URL` - Endpoint CDP (default `http://127.0.0.1:9222`)
- `SPOTIFY_BRAVE_PATH` - Path manual ke `brave.exe` jika tidak terdeteksi otomatis
- `SPOTIFY_BRAVE_USER_DATA_DIR` - Lokasi profil khusus (bisa diubah jika perlu)
- Timeout bisa disesuaikan sesuai koneksi

## 4. Menjalankan Brave dengan CDP (pertama kali)

1. Tutup Brave sepenuhnya (jika sedang terbuka dengan profil yang sama).
2. Jalankan `scripts\start-brave-spotify.bat`
3. Brave akan terbuka di `https://open.spotify.com` dengan profil khusus
4. **Login** ke akun Spotify kamu di tab tersebut
5. Biarkan window Brave tetap terbuka

> Catatan: Jika Brave kamu terinstall di lokasi berbeda, script akan mencoba mendeteksinya. Kamu bisa set `SPOTIFY_BRAVE_PATH`.

## 5. Menjalankan Joy Bot

1. Pastikan Brave dengan CDP masih terbuka (dengan Spotify Web sudah login)
2. Jalankan bot: `npm start` atau `node index.js`
3. Tunggu sampai bot online

## 6. Perintah WhatsApp

Semua perintah diawali prefix bot (default `.` seperti di `config/bot.js`).

### Playback

| Perintah | Kegunaan |
|---|---|
| `.play` | Melanjutkan pemutaran (jika sedang paused) |
| `.pause` | Menjeda pemutaran |
| `.next` atau `.n` | Lagu berikutnya |
| `.prev`, `.pre`, atau `.previous` | Lagu sebelumnya |

### Cari & Putar Lagu

| Perintah | Kegunaan |
|---|---|
| `.play <judul lagu>` | Cari dan putar lagu |
| `.play <judul lagu> artist <nama artis>` | Cari dengan prioritas artis yang lebih tepat |

Contoh:

```text
.play perfect ed sheeran
.play apatis ria
.play ini abadi artist perunggu
```

### Cari & Putar Playlist

| Perintah | Kegunaan |
|---|---|
| `.play playlist <nama playlist>` | Cari playlist, buka playlist, dan putar |

Contoh:

```text
.play playlist chill hits
```

### Status Pemutaran

| Perintah | Kegunaan |
|---|---|
| `.spotatus` | Menampilkan status saat ini (judul, artis, posisi/durasi, status) |

Format contoh:

```text
🎧 SPOTIFY STATUS
🎵 Lagu: Ini Abadi
👤 Artis: Perunggu
⏱️ Posisi: 0:13 / 2:21
▶️ Status: Playing
```

## 7. Cara Kerja (ringkas)

1. **Attach** - Controller connect ke Brave via `chromium.connectOverCDP()` ke `http://127.0.0.1:9222`
2. **Temukan tab** - Cari tab yang sudah membuka `open.spotify.com` / `accounts.spotify.com`. Jika tidak ada, buat tab baru di context yang sama.
3. **Cari** - Untuk `.play <query>`, buka `/search/...`, tunggu hasil render, pilih hasil terbaik (matching judul+artis)
4. **Putar** - Klik kontrol Play yang benar (di baris hasil atau di halaman track/playlist)
5. **Verifikasi** - Tunggu dan pastikan lagu yang benar jadi pemutaran dan status menjadi `Playing`. Jika tidak terverifikasi, bot akan mengembalikan error (tidak bohong claim sukses)

## 8. Troubleshooting

| Masalah | Solusi |
|---|---|
| `Tidak dapat terhubung ke Brave CDP` | Pastikan Brave dijalankan lewat `start-brave-spotify.bat`. Cek port 9222 tidak dipakai aplikasi lain. |
| `Spotify Web belum login` | Login di tab Spotify pada Brave automation, biarkan tetap terbuka, kirim ulang perintah. |
| `Lagu tidak ditemukan` | Coba tulis lebih spesifik atau tambahkan `artist <nama>`. Spotify Web bisa punya variasi ejaan. |
| `Tombol Play tidak terdeteksi` | Struktur DOM Spotify bisa berubah. Coba lagi atau pastikan halaman sudah penuh dimuat. |
| `Status pemutaran tidak terverifikasi` | Bisa karena akun premium diperlukan, dialog muncul, atau lagu tidak bisa diputar. Bot akan melaporkan error jelas. |

## 9. Catatan Penting

- **Jangan commit profil**: `.spotify-profile/` sudah ada di `.gitignore` sebelumnya. Profil khusus CDP juga tidak perlu di-commit.
- **Hanya untuk testing lokal**: Remote debugging hanya di localhost.
- **Tidak mengganggu bot lain**: Controller menggunakan queue, error tidak akan crash WhatsApp bot.
- **Playwright sudah terinstall**: Proyek sudah pakai `playwright ^1.64.1`, jadi bisa reuse.
- **Tidak menambah HTTP server**: Implementasi berupa service methods, terintegrasi langsung ke command handler.
