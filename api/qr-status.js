// api/qr-status.js — Vercel Serverless Function
//
// Polls the on-disk status/creds written by qr-start.js for a given
// session id. See the big caveat in qr-start.js: because the live Baileys
// socket lives in THAT function's process memory, and this is a separate
// request that may hit a different (cold) instance, this endpoint can
// only reliably detect the scan via the creds.json file that Baileys
// writes to /tmp as part of `saveCreds` — it cannot itself keep the
// socket alive to send you the session message the way api/pair.js does.
//
// Practical result: if this request happens to land on the SAME warm
// instance as qr-start.js (common within the same minute or two on
// Vercel), everything works end-to-end. If it lands on a different
// instance, /tmp won't have the session files and this will correctly
// report "not found" rather than hanging or silently failing.
//
// RECOMMENDATION: use /api/pair (pairing-code flow) as the primary,
// reliable method on Vercel. Treat this QR flow as best-effort.

import fs from "fs";
import os from "os";
import path from "path";

const SESSIONS_ROOT = path.join(os.tmpdir(), "qr_sessions");

function buildSessionString(credsPath) {
    const credsData = fs.readFileSync(credsPath, "utf-8");
    const base64Creds = Buffer.from(credsData).toString("base64");
    return `SARWAR-MD~${base64Creds}`;
}

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const sessionId = String(req.query.id || "");
    if (!sessionId) return res.status(400).json({ error: "id required" });

    const dir = path.join(SESSIONS_ROOT, sessionId);
    const statusPath = path.join(dir, "status.json");
    const credsPath = path.join(dir, "creds.json");

    if (!fs.existsSync(dir)) {
        return res.status(404).json({
            success: false,
            state: "not_found",
            message: "Session not found on this instance. This can happen on Vercel if your poll request landed on a different serverless instance than the one that generated the QR. Please use the pairing-code method (/api/pair) instead for guaranteed reliability.",
        });
    }

    let status = { state: "waiting_scan" };
    try {
        if (fs.existsSync(statusPath)) {
            status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        }
    } catch {}

    if (status.state === "connected" && fs.existsSync(credsPath)) {
        try {
            const sessionString = buildSessionString(credsPath);
            // Clean up now that we've extracted what we need.
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
            return res.status(200).json({
                success: true,
                state: "connected",
                session: sessionString,
                message: "Paired successfully. Save this session string.",
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    return res.status(200).json({
        success: true,
        state: status.state || "waiting_scan",
        message: status.state === "expired" || status.state === "closed"
            ? "QR session expired or closed. Please request a new QR code."
            : "Still waiting for you to scan the QR code.",
    });
}
