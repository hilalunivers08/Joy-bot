@echo off
REM ==========================================================
REM Joy Bot - Spotify Web (Brave) CDP Startup
REM ==========================================================
REM
REM Tujuan:
REM   Menjalankan Brave dengan remote debugging aktif di localhost
REM   sehingga Joy Bot bisa attach ke Spotify Web via Playwright CDP.
REM
REM PENTING KEAMANAN:
REM   - Remote debugging HANYA untuk 127.0.0.1
REM   - Jangan expose port ini ke jaringan/LAN
REM   - Gunakan profil khusus (bukan profil normal kamu)
REM   - Jangan salin/overwrite profil Brave yang biasa kamu pakai
REM
REM KONFIGURASI:
REM   Kamu bisa override lewat environment variable:
REM     BRAVE_PATH                - Path ke brave.exe
REM     SPOTIFY_BRAVE_PATH        - Sama dengan BRAVE_PATH (fallback)
REM     SPOTIFY_BRAVE_USER_DATA_DIR - Folder profil khusus untuk automation
REM     SPOTIFY_CDP_PORT          - Default: 9222
REM
REM PERTAMA KALI:
REM   1. Jalankan script ini
REM   2. Buka https://open.spotify.com dan login ke akun Spotify kamu
REM   3. Biarkan Brave tetap terbuka (jangan tutup)
REM   4. Jalankan Joy Bot, lalu coba .play atau .spotatus
REM
REM ==========================================================

setlocal enabledelayedexpansion

REM Port CDP (hanya localhost)
if "%SPOTIFY_CDP_PORT%"=="" set "CDP_PORT=9222"
if "%SPOTIFY_CDP_PORT%" NEQ "" set "CDP_PORT=%SPOTIFY_CDP_PORT%"

REM Path Brave
if "%SPOTIFY_BRAVE_PATH%" NEQ "" (
  set "BRAVE_PATH=%SPOTIFY_BRAVE_PATH%"
)
if "%BRAVE_PATH%"=="" (
  if exist "%PROGRAMFILES%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BRAVE_PATH=%PROGRAMFILES%\BraveSoftware\Brave-Browser\Application\brave.exe"
  ) else if exist "%PROGRAMFILES(X86)%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BRAVE_PATH=%PROGRAMFILES(X86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
  ) else if exist "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BRAVE_PATH=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
  )
)

if not exist "!BRAVE_PATH!" (
  echo [ERROR] Brave tidak ditemukan.
  echo Atur BRAVE_PATH atau SPOTIFY_BRAVE_PATH ke brave.exe
  pause
  exit /b 1
)

REM Gunakan profil KHUSUS untuk automation. JANGAN pakai profil normal.
if "%SPOTIFY_BRAVE_USER_DATA_DIR%" NEQ "" (
  set "USER_DATA_DIR=%SPOTIFY_BRAVE_USER_DATA_DIR%"
)
if "%USER_DATA_DIR%"=="" (
  set "USER_DATA_DIR=%LOCALAPPDATA%\BraveSoftware\Brave-Browser-Spotify-Automation"
)

echo [INFO] Brave: !BRAVE_PATH!
echo [INFO] User Data Dir (profil khusus): !USER_DATA_DIR!
echo [INFO] CDP: http://127.0.0.1:!CDP_PORT!
echo [INFO] Binding ke 127.0.0.1 saja. Tidak expose ke jaringan.
echo.

if not exist "!USER_DATA_DIR!" (
  echo [INFO] Membuat profil khusus baru...
  mkdir "!USER_DATA_DIR!" 2>nul
)

REM Jalankan Brave dengan remote debugging (localhost only)
start "" "!BRAVE_PATH!" ^
  --remote-debugging-address=127.0.0.1 ^
  --remote-debugging-port=!CDP_PORT! ^
  --user-data-dir="!USER_DATA_DIR!" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-mode ^
  --disable-extensions ^
  https://open.spotify.com

echo [OK] Brave dijalankan dengan CDP.
echo.
echo Langkah pertama kali:
echo 1. Login ke Spotify Web di jendela Brave ini
echo 2. Biarkan Brave tetap terbuka
echo 3. Jalankan Joy Bot (npm start)
echo 4. Coba perintah: .spotatus  atau  .play ini abadi artist perunggu
echo.
echo [PERINGATAN] Jangan tutup window ini. Jangan ganti ke profil Brave biasa.
pause
