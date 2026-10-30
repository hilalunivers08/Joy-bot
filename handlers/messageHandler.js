const processingCommands = new Set();
const MAX_MESSAGE_AGE_SECONDS = 20;

const ownerCommands = require("../commands/owner");
const reg = require("../commands/system/reg");
const tiktok = require("../commands/downloader/tiktok");
const mp3 = require("../commands/downloader/mp3");
const daily = require("../commands/economy/daily");
const transaction = require("../commands/economy/transaction");
const bot = require("../config/bot");
const stats = require("../commands/system/stats");
const menu = require("../commands/system/menu");
const aiHandler = require("../commands/ai/aiHandler");
const quote = require("../commands/games/quote");
const tebakangka = require("../commands/games/tebakangka");
const tebakgambar = require("../commands/games/tebakgambar");
const tebaklogo = require("../commands/games/tebaklogo");
const quiz = require("../commands/games/quiz");
const qumath = require("../commands/games/qumath");
const slot = require("../commands/games/slot");
const say = require("../commands/owner/say");
const sticker = require("../commands/media/sticker");
const brat = require("../commands/media/brat");
const tomed = require("../commands/media/tomed");
const shop = require("../commands/economy/shop");
const inventory = require("../commands/economy/inventory");
const leaderboard = require("../database/leaderboard");
const spotify = require("../commands/system/spotify");



async function resolveSenderJid(Joy, msg) {
    const isGroup =
        msg.key.remoteJid?.endsWith("@g.us");

    const candidates = isGroup
        ? [
            msg.key.participantAlt,
            msg.key.participant
        ]
        : [
            msg.key.remoteJidAlt,
            msg.key.remoteJid
        ];

    const phoneJid = candidates.find(
        jid =>
            typeof jid === "string" &&
            jid.endsWith("@s.whatsapp.net")
    );

    if (phoneJid) {
        return phoneJid;
    }

    const lidJid = candidates.find(
        jid =>
            typeof jid === "string" &&
            jid.endsWith("@lid")
    );

    if (lidJid) {
        try {
            const mappedJid =
                await Joy.signalRepository
                    ?.lidMapping
                    ?.getPNForLID(lidJid);

            if (
                typeof mappedJid === "string" &&
                mappedJid.endsWith("@s.whatsapp.net")
            ) {
                return mappedJid;
            }
        } catch {}
    }

    return candidates.find(Boolean) ||
        msg.key.remoteJid;
}


async function messageHandler(Joy, m) {
    const msg = m.messages[0];

    if (!msg?.message) return;

    //ignoer 20 s command
    const messageTimestamp = Number(msg.messageTimestamp);

    if (
        Number.isFinite(messageTimestamp) &&
        messageTimestamp > 0
    ) {
        const ageSeconds =
            Date.now() / 1000 - messageTimestamp;

        if (ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
            return;
        }
    }

    const sender = msg.key.remoteJid;

    const actualSender =
        await resolveSenderJid(Joy, msg);

    const authorNumber = "222079890813069";

    const senderNumber = String(actualSender)
        .split("@")[0]
        .split(":")[0];

    const isAuthor =
        senderNumber === authorNumber;

    const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.text ||
        msg.message.videoMessage?.text ||
        "";

    const text = body.trim();

    const reply = async (text) => {
        await Joy.sendMessage(
            sender,
            { text },
            { quoted: msg }
        );
    };

    const contextInfo =
        msg.message.extendedTextMessage?.contextInfo ||
        msg.message.imageMessage?.contextInfo ||
        msg.message.videoMessage?.contextInfo;

    const quotedId = contextInfo?.stanzaId;
    // 10/9
    const quotedMessage = contextInfo?.quotedMessage;

    const quotedText =
        quotedMessage?.conversation ||
        quotedMessage?.extendedTextMessage?.text ||
        quotedMessage?.imageMessage?.caption ||
        quotedMessage?.videoMessage?.caption ||
        "";


    // Periksa apakah pesan merupakan balasan ke pesan Joy
    const isReplyToBot =
        quotedId &&
        Joy.sentMessages?.has(
            `${sender}:${quotedId}`
        );

    // AI otomatis saat pengguna membalas pesan Joy
    if (
        isReplyToBot &&
        text &&
        !text.startsWith(bot.prefix)
    ) {
        if (
            Joy.tebakgambar?.[sender] &&
            (quotedText.includes("TEBAK GAMBAR") || Joy.tebakgambar[sender].msgId === quotedId)
        ) {
            await tebakgambar.handleAnswer(
                Joy,
                msg,
                reply,
                text
            );
            return;
        }

        if (
            Joy.tebaklogo?.[sender] &&
            (quotedText.includes("TEBAK LOGO") || Joy.tebaklogo[sender].msgId === quotedId)
        ) {
            await tebaklogo.handleAnswer(
                Joy,
                msg,
                reply,
                text
            );
            return;
        }

        let isGameReply = false;

        if (
            Joy.activeQuiz?.[sender] &&
            (quotedText.includes("KUIS TRIVIA") || Joy.activeQuiz[sender].msgId === quotedId)
        ) {
            await quiz.handleAnswer(
                Joy,
                msg,
                reply,
                text,
                false
            );
            return;
        } else if (
            Joy.qumath?.[sender] &&
            (quotedText.includes("KUIS MATEMATIKA") || Joy.qumath[sender].msgId === quotedId)
        ) {
            await qumath.handleAnswer(
                Joy,
                msg,
                reply,
                text,
                false
            );
            return;
        }

        // Jika ada game apapun yang sedang aktif, jangan biarkan AI ikut campur saat user me-reply pesan bot
        if (
            Joy.tebakgambar?.[sender] ||
            Joy.tebaklogo?.[sender] ||
            Joy.activeQuiz?.[sender] ||
            Joy.qumath?.[sender]
        ) {
            return;
        }

        await aiHandler.handleReply(
            Joy,
            msg,
            reply,
            text,
            quotedText
        );

        return;
    }

    // Deteksi jawaban Tebak Logo langsung di chat (tanpa prefix dan tanpa harus reply)
    if (Joy.tebaklogo?.[sender] && text && !text.startsWith(bot.prefix)) {
        const answered = await tebaklogo.handleAnswer(
            Joy,
            msg,
            reply,
            text,
            true
        );
        if (answered) return;
    }

    // Deteksi jawaban kuis langsung di chat (tanpa prefix dan tanpa harus reply)
    if (Joy.activeQuiz?.[sender] && text && !text.startsWith(bot.prefix)) {
        const answered = await quiz.handleAnswer(
            Joy,
            msg,
            reply,
            text,
            true
        );
        if (answered) return;
    }

    // Deteksi jawaban kuis matematika langsung di chat (angka)
    if (Joy.qumath?.[sender] && text && !text.startsWith(bot.prefix)) {
        const answered = await qumath.handleAnswer(
            Joy,
            msg,
            reply,
            text,
            true
        );
        if (answered) return;
    }

    // Hanya command berprefix yang diproses sampai sini. Pesan biasa tanpa
    // prefix (termasuk jawaban game) sudah ditangani/diabaikan di atas, sehingga
    // game yang sedang aktif tidak pernah dimatikan oleh command lain, dan
    // command seperti .nyerah/.menu tetap sampai ke dispatcher meski game aktif.
    if (!text.startsWith(bot.prefix)) return;

    const commandText =
        text.slice(bot.prefix.length).trim();

    if (!commandText) return;

    const parts = commandText.split(/\s+/);

    const command =
        parts[0].toLowerCase();

    const args =
        parts.slice(1);

    const commandKey = `${sender}:${senderNumber}`;

    if (processingCommands.has(commandKey)) {
        return;
    }

    processingCommands.add(commandKey);
    try {
    switch (command) {

          // QUOTE
        case "quote":
            await quote(
                Joy,
                msg,
                reply,
                args
            );
            break;

        // TEBAK ANGKA
        case "tebakangka":
        case "tebak":
            await tebakangka(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // TEBAK GAMBAR
        case "tebakgambar":
        case "tg":
        case "jawab":
            await tebakgambar(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // TEBAK LOGO
        case "tebaklogo":
        case "tl":
            await tebaklogo(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // CLUE / HINT — universal, cek game aktif
        // Untuk menambah game baru: ekspor handleClue dari modul game,
        // lalu tambah blok else-if sesuai pola di bawah
        case "clue":
        case "hint": {
            if (Joy.tebakgambar?.[sender]) {
                // Tebak Gambar mendukung clue
                await tebakgambar.handleClue(Joy, msg, reply);
            } else if (Joy.tebaklogo?.[sender]) {
                // Tebak Logo tidak memiliki fitur clue
                await reply("💡 Game *Tebak Logo* tidak memiliki fitur clue.");
            } else if (Joy.activeQuiz?.[sender]) {
                // Kuis tidak memiliki fitur clue
                await reply("💡 Game *Kuis Trivia* tidak memiliki fitur clue.");
            } else if (Joy.qumath?.[sender]) {
                // Kuis matematika tidak memiliki fitur clue
                await reply("💡 Game *Kuis Matematika* tidak memiliki fitur clue.");
            } else {
                await reply("❌ Tidak ada game yang sedang berlangsung di chat ini.");
            }
            break;
        }

        // KUIS TRIVIA
        case "quiz":
        case "kuis":
            await quiz(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // KUIS MATEMATIKA
        case "qumath":
        case "kumath":
        case "qumatematika":
        case "qmath":
            await qumath(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // NYERAH UNIVERSAL (tebakgambar & quiz)
        case "nyerah":
        case "surrender": {
            const hasTG = !!Joy.tebakgambar?.[sender];
            const hasTL = !!Joy.tebaklogo?.[sender];
            const hasQuiz = !!Joy.activeQuiz?.[sender];
            const hasQumath = !!Joy.qumath?.[sender];

            if (hasTG) {
                await tebakgambar(
                    Joy,
                    msg,
                    reply,
                    args,
                    "nyerah",
                    { callerJid: actualSender, isAuthor }
                );
            } else if (hasTL) {
                await tebaklogo.handleNyerah(Joy, msg, reply, { callerJid: actualSender, isAuthor });
            } else if (hasQuiz) {
                await quiz.handleNyerah(Joy, msg, reply, { callerJid: actualSender, isAuthor });
            } else if (hasQumath) {
                await qumath.handleNyerah(Joy, msg, reply, { callerJid: actualSender, isAuthor });
            } else {
                await reply("*Tidak ada game yang sedang berlangsung di chat ini.*");
            }
            break;
        }

        // SLOT MACHINE 777
        case "777":
            await slot(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // STATS
        case "stats":
            await stats(
                Joy,
                msg,
                reply,
                args,
                command,
                { isAuthor }
            );
            break;

        // AI CHAT

            case "ai":
            case "groq":
            case "Groq":
                await aiHandler.handleCommand(
                    Joy,
                    msg,
                    reply,
                    args,
                    command,
                    {
                        errorMessage: "⚠ Gagal saat memproses pertanyaan."
                    }
                );
                break;


        // REGISTRASI
        case "reg":
            await reg(
                Joy,
                msg,
                reply
            );
            break;

        // MENU
        case "menu":
        case "mainmenu":
        case "gamesmenu":
        case "toolsmenu":
        case "downloadermenu":
        case "funmenu":
        case "accountmenu":
            await menu(
                Joy,
                msg,
                reply,
                command
            );
            break;

        // DAILY REWARD
        case "daily":
            await daily(
                Joy,
                msg,
                reply
            );
            break;

        // TRANSAKSI DAN balance
        case "tf":
        case "tmsl":
        case "krsl":
        case "balance":
            await transaction(
                Joy,
                msg,
                reply,
                args,
                command,
                { isAuthor }
            );
            break;

        // BRAT
        case "brat":
            await brat(
                Joy,
                msg,
                reply,
                args
            );
            break;

        // STICKER
        case "sticker":
        case "s":
            await sticker(
                Joy,
                msg,
                reply
            );
            break;

        // STICKER TO IMAGE
        case "tomed":
        case "toimg":
            await tomed(
                Joy,
                msg,
                reply
            );
            break;

        // SHOP DAN INVENTORI
        case "shop":
        case "buy":
            await shop(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        case "inventory":
        case "inv":
            await inventory(
                Joy,
                msg,
                reply
            );
            break;

                // leaderboard

        case "topbalance":
        case "ldbalance":
        case "leadbalance":
        case "lbbalance":
            
        case "leadtg":
        case "leadertg":
        case "lbtg":

        case "leadquiz":
        case "ldquiz":
        case "leaderquiz":
        case "lbquiz":

        case "leadqumath":
        case "leadkumath":
        case "ldqumath":
        case "lbqumath":
        case "leadmath":
            await leaderboard(
                Joy,
                msg,
                reply,
                args,
                command
            );
            break;

        // TIKTOK DOWNLOADER
        case "ttdl":
        case "tiktok":
            await tiktok.execute(
                Joy,
                msg,
                args
            );
            break;

        // MP3 DOWNLOADER
        case "mp3":
            await mp3.execute(
                Joy,
                msg,
                args
            );
            break;


        case "say":
            await say(
                Joy,
                msg,
                reply,
                args
            );
            break;

        // AUTHOR ONLY
        case "restart":
        case "debug":
        case "ping":
        case "uptime":
        case "jid":
        case "dlmsg":
        case "aaeiilnndraatt":

            await ownerCommands(
                Joy,
                msg,
                reply,
                args,
                command,
                { isAuthor }
            );

        // spotify plauer

        case "play":
        case "pause":
        case "next":
        case "prev":
        case "previous":
        case "spotatus":
        await spotify.execute(Joy, msg, args, command);
        break;

    }
    } finally {
        processingCommands.delete(commandKey);
    }   
}

module.exports = messageHandler;