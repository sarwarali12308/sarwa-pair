// api/qr-start.js — Vercel Serverless Function
//
// ARCHITECTURE NOTE (QR flow is different from the pairing-code flow):
// A QR flow fundamentally needs at least TWO steps: (1) show the QR code
// so the user can scan it, (2) find out once they've scanned it. A single
// HTTP request/response can't do both — the response has to go out with
// the QR image before the user can even scan it.
//
// So this is split into two serverless functions that share state through
// a JSON file on disk:
//   - qr-start.js  (this file) generates the QR, saves the in-progress
//     Baileys session under /tmp/qr_sessions/<id>, and returns the QR
//     image + that id right away.
//   - qr-status.js polls using that id: if the phone has scanned and the
//     connection opened, it finishes the session generation, sends it to
//     the user's WhatsApp, and reports done; otherwise it reports "still
//     waiting".
//
// CAVEAT: Vercel serverless instances are not guaranteed to stay warm or
// reuse the same instance between two separate requests, and /tmp is
// ephemeral per-instance. In practice Vercel does frequently reuse a warm
// instance for a few minutes after the first request, which is usually
// enough for a QR scan — but this is inherently less reliable on
// serverless than the pairing-code flow above, which completes fully
// within one single request. If QR pairing seems unreliable, prefer the
// pairing-code (/api/pair) flow instead — it's the one guaranteed to work
// under Vercel's serverless model.

import fs from "fs";
import os from "os";
import path from "path";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";

export const config = {
    maxDuration: 30,
};

const SESSIONS_ROOT = path.join(os.tmpdir(), "qr_sessions");

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const sessionId = Date.now().toString() + Math.random().toString(36).slice(2, 10);
    const dir = path.join(SESSIONS_ROOT, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    let responded = false;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
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

        sock.ev.on("creds.update", saveCreds);

        // Write a status file so qr-status.js can track progress across
        // the separate request that will poll this session.
        const statusPath = path.join(dir, "status.json");
        fs.writeFileSync(statusPath, JSON.stringify({ state: "waiting_scan" }));

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (!responded) {
                    responded = true;
                    fs.writeFileSync(statusPath, JSON.stringify({ state: "expired" }));
                    res.status(408).json({ success: false, error: "QR generation timed out" });
                }
                resolve();
            }, 25000);

            sock.ev.on("connection.update", async (update) => {
                const { connection, qr } = update;

                if (qr && !responded) {
                    responded = true;
                    clearTimeout(timeout);
                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: "M",
                            type: "image/png",
                            quality: 0.92,
                            margin: 1,
                            color: { dark: "#000000", light: "#FFFFFF" },
                        });
                        res.status(200).json({
                            success: true,
                            sessionId,
                            qr: qrDataURL,
                            message: "Scan this QR code with WhatsApp, then poll /api/qr-status?id=" + sessionId,
                        });
                    } catch (qrErr) {
                        res.status(500).json({ success: false, error: qrErr.message });
                    }
                    resolve();
                    // NOTE: the socket is intentionally left open after
                    // responding — qr-status.js's polling relies on this
                    // process instance (or the on-disk creds, once saved)
                    // to detect the scan. See the reliability caveat above.
                }

                if (connection === "open") {
                    fs.writeFileSync(statusPath, JSON.stringify({ state: "connected" }));
                }

                if (connection === "close" && !responded) {
                    responded = true;
                    clearTimeout(timeout);
                    fs.writeFileSync(statusPath, JSON.stringify({ state: "closed" }));
                    res.status(500).json({ success: false, error: "Connection closed before QR could be generated" });
                    resolve();
                }
            });
        });
    } catch (err) {
        console.error("QR start error:", err);
        if (!responded) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
}
