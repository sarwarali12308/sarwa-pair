// api/pair.js — Vercel Serverless Function
//
// IMPORTANT ARCHITECTURE NOTE:
// The original version of this generator returned the HTTP response as
// soon as the pairing code was issued, while the rest of the work
// (waiting for the phone to link, then generating/sending the session)
// continued in the BACKGROUND after the response was sent. Background
// work has no guarantee of continuing on Vercel once a function's
// response is sent — the instance can be frozen or killed right after.
//
// This version restructures the whole flow into ONE await chain inside a
// single request: request pairing code -> wait for the phone to actually
// link (with a timeout) -> generate + send the session -> THEN respond
// with the pairing code and status. Nothing happens in the background
// after the response goes out.
//
// Practical effect: the HTTP request stays open until the user has
// entered the pairing code on their phone and WhatsApp has confirmed the
// link (or the timeout hits). Vercel Hobby functions can run up to 60s
// (see maxDuration below) — the user needs to enter the code quickly.

import fs from "fs";
import os from "os";
import path from "path";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";

export const config = {
    maxDuration: 60,
};

function rm(p) {
    try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
        console.log("Cleanup error:", e);
    }
}

function buildSessionString(credsPath) {
    const credsData = fs.readFileSync(credsPath, "utf-8");
    const base64Creds = Buffer.from(credsData).toString("base64");
    return `SARWAR-MD~${base64Creds}`;
}

// Wraps any promise with a hard timeout so a slow/hanging step (network
// call, WebSocket handshake, etc.) can never leave the client waiting
// forever with no response — it always surfaces as a JSON error instead.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Step timed out: ${label} (>${ms}ms)`)), ms)
        ),
    ]);
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    let num = String(req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.status(400).json({ error: "Number required" });

    const phoneCheck = pn("+" + num);
    if (!phoneCheck.isValid()) return res.status(400).json({ error: "Invalid number" });
    num = phoneCheck.getNumber("e164").replace("+", "");

    const dir = path.join(os.tmpdir(), `session_${num}_${Date.now()}`);
    rm(dir);

    let sock;
    let settled = false;
    let pairingCode;

    // Global safety net: no matter what hangs below, this guarantees SOME
    // JSON response goes out well before Vercel's own function timeout
    // kills the instance (which is what was causing the silent "blank"
    // hang — Vercel doesn't send any response body when it force-kills a
    // function, the browser just sees nothing).
    let globalTimer;
    const globalGuard = new Promise((_, reject) => {
        globalTimer = setTimeout(() => {
            reject(new Error("Overall request timed out before pairing completed. This usually means the server is slow to start (cold start) or WhatsApp's servers are slow to respond right now — please try again."));
        }, 55000);
    });

    try {
        console.log(`[PAIR] start for ${num}`);

        const authResult = await withTimeout(
            useMultiFileAuthState(dir),
            8000,
            "useMultiFileAuthState"
        );
        const { state, saveCreds } = authResult;
        console.log("[PAIR] auth state ready");

        const { version } = await withTimeout(
            fetchLatestBaileysVersion(),
            10000,
            "fetchLatestBaileysVersion"
        );
        console.log("[PAIR] baileys version fetched:", version);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });
        console.log("[PAIR] socket created");

        sock.ev.on("creds.update", saveCreds);

        const connectionOpened = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error("Timed out waiting for pairing. Enter the pairing code on your phone within ~45s of requesting it, then try again."));
                }
            }, 45000);

            sock.ev.on("connection.update", (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open" && !settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve();
                }

                if (connection === "close" && !settled) {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === 401) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error("Session closed/unauthorized before pairing completed."));
                    }
                }
            });
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            console.log("[PAIR] requesting pairing code...");
            pairingCode = await withTimeout(
                sock.requestPairingCode(num),
                15000,
                "requestPairingCode"
            );
            pairingCode = pairingCode?.match(/.{1,4}/g)?.join("-") || pairingCode;
            console.log("[PAIR] pairing code received:", pairingCode);
        }

        await Promise.race([connectionOpened, globalGuard]);
        clearTimeout(globalTimer);
        console.log("[PAIR] connection opened");

        await delay(2000);
        const credsPath = path.join(dir, "creds.json");
        const sessionString = buildSessionString(credsPath);

        const jid = jidNormalizedUser(num + "@s.whatsapp.net");

        await sock.sendMessage(jid, { text: sessionString });
        await delay(1500);

        const fakeVCardQuoted = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast",
            },
            message: {
                contactMessage: {
                    displayName: "© SARWAR-MD",
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:© SARWAR-MD\nORG: SARWARMD Official;\nTEL;type=CELL;type=VOICE;waid=13135550002:+13135550002\nEND:VCARD`,
                },
            },
        };

        const caption = `╭━〔 *ꜱᴀʀᴡᴀʀ-ᴍᴅ* 〕━··๏
┃★╭──────────────
┃★│ 👑 Owner : *SarwarMD Official*
┃★│ 🤖 Baileys : *Multi Device*
┃★│ 💻 Type : *NodeJs*
┃★│ 🚀 Platform : *Vercel*
┃★│ ⚙️ Mode : *Public*
┃★│ 🔣 Prefix : *[ . ]*
┃★│ 🏷️ Version : *8.0.0*
┃★╰──────────────
╰━━━━━━━━━━━━━━┈⊷`;

        await sock.sendMessage(
            jid,
            {
                image: { url: "https://files.catbox.moe/vwg0va.jpg" },
                caption,
                contextInfo: {
                    mentionedJid: [jid],
                    forwardingScore: 999,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: "120363425072775595@newsletter",
                        newsletterName: "❀༒★[ꜱᴀʀᴡᴀʀ-ᴍᴅ]★༒❀",
                        serverMessageId: 143,
                    },
                },
            },
            { quoted: fakeVCardQuoted }
        );

        return res.status(200).json({
            success: true,
            code: pairingCode,
            message: "Session generated and sent to your WhatsApp number.",
        });
    } catch (err) {
        console.error("[PAIR] Error:", err.message);
        return res.status(500).json({
            success: false,
            error: err.message,
            code: pairingCode || null,
        });
    } finally {
        try {
            sock?.end?.();
        } catch {}
        rm(dir);
    }
}
