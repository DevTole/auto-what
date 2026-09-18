import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';

let whatsAppSocket = null;
let isReady = false;
let latestQR = null;
let connectionState = 'starting';

const app = express();
const port = Number(process.env.PORT) || 3000;
const requestWindowMs = 60 * 1000;
const requestLimit = 25;
const requestTimestamps = new Map();

app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    const now = Date.now();
    const timestamps = (requestTimestamps.get(req.ip) || [])
        .filter((timestamp) => now - timestamp < requestWindowMs);

    if (timestamps.length >= requestLimit) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    timestamps.push(now);
    requestTimestamps.set(req.ip, timestamps);
    next();
});

function normalizeKenyanNumber(input) {
    if (input === undefined || input === null) return null;
    let digits = String(input).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('254')) {
    } else if (digits.startsWith('0')) {
        digits = '254' + digits.slice(1);
    } else if (digits.length === 9) {
        digits = '254' + digits;
    } else {
        return null;
    }
    if (!/^254(7|1)\d{8}$/.test(digits)) return null;
    return digits;
}

app.get('/test', (req, res) => {
    res.json({ status: 'ok', whatsappReady: isReady, connectionState });
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', whatsappReady: isReady });
});

app.get('/qr', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (isReady) {
        return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>WhatsApp Bot</title>
<meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b141a;color:#e9edef}
.box{text-align:center;padding:32px;border-radius:16px;background:#111b21;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.ok{font-size:48px}</style></head>
<body><div class="box">
<div class="ok">✅</div>
<h1>WhatsApp is connected</h1>
<p>No QR needed. The bot is ready to send OTPs.</p>
</div></body></html>`);
    }

    if (!latestQR) {
        return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>WhatsApp Bot</title>
<meta http-equiv="refresh" content="3">
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b141a;color:#e9edef}
.box{text-align:center;padding:32px;border-radius:16px;background:#111b21;box-shadow:0 10px 30px rgba(0,0,0,.4)}</style></head>
<body><div class="box">
<h1>Waiting for QR…</h1>
<p>Connection state: <b>${connectionState}</b></p>
<p>This page refreshes automatically.</p>
</div></body></html>`);
    }

    try {
        const dataUrl = await QRCode.toDataURL(latestQR, {
            width: 360,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });

        return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Scan WhatsApp QR</title>
<meta http-equiv="refresh" content="20">
<style>
body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b141a;color:#e9edef}
.box{text-align:center;padding:32px;border-radius:16px;background:#111b21;box-shadow:0 10px 30px rgba(0,0,0,.4);max-width:420px}
img{width:100%;max-width:360px;border-radius:12px;background:#fff;padding:12px}
h1{margin:0 0 8px;font-size:20px}
p{margin:8px 0;color:#8696a0;font-size:14px}
.steps{text-align:left;display:inline-block;margin-top:12px;color:#8696a0;font-size:13px;line-height:1.6}
</style></head>
<body><div class="box">
<h1>Scan to connect WhatsApp</h1>
<img src="${dataUrl}" alt="WhatsApp QR" />
<p>This QR refreshes automatically every 20 seconds.</p>
<div class="steps">
1. Open WhatsApp on your phone<br>
2. Tap <b>Settings → Linked Devices</b><br>
3. Tap <b>Link a Device</b><br>
4. Scan this QR
</div>
</div></body></html>`);
    } catch (err) {
        console.error('Failed to render QR:', err);
        return res.status(500).send('Failed to render QR');
    }
});

app.post('/send', async (req, res) => {
    const { phone_number, totp_code } = req.body || {};

    const otp = totp_code === undefined || totp_code === null
        ? ''
        : String(totp_code).trim();

    if (!otp) {
        return res.status(400).json({ error: 'totp_code is required' });
    }

    const recipient = normalizeKenyanNumber(phone_number);

    if (!recipient) {
        return res.status(400).json({
            error: 'phone_number must be a valid Kenyan number (0…, 254…, or +254…)',
        });
    }

    if (!isReady || !whatsAppSocket) {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }

    try {
        const jid = `${recipient}@s.whatsapp.net`;

        const [onWa] = await whatsAppSocket.onWhatsApp(jid);
        if (!onWa?.exists) {
            return res.status(400).json({ error: 'Number is not registered on WhatsApp' });
        }

        const targetJid = onWa.jid || jid;

        const sent = await whatsAppSocket.sendMessage(targetJid, {
            text: `Your OTP code is ${otp}. Do not share it with anyone.`,
        });

        return res.json({
            sent: true,
            messageId: sent?.key?.id ?? null,
            to: targetJid,
        });
    } catch (error) {
        console.error('Failed to send OTP:', error?.message ?? error);
        return res.status(502).json({ error: 'Unable to send the OTP' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${port}`);
});

export async function loginBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('csk-bot-auth');
        const { version } = await fetchLatestBaileysVersion();

        const socket = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            browser: ['csk-bot', 'Chrome', '14.4.0'],
            shouldSyncHistoryMessages: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: 'retry' }),
        });

        socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQR = qr;
                connectionState = 'qr';
                console.log('New QR generated — open /qr to scan');
            }

            if (connection === 'connecting') {
                connectionState = 'connecting';
            }

            if (connection === 'close') {
                isReady = false;
                whatsAppSocket = null;
                connectionState = 'closed';

                const disconnectError = lastDisconnect?.error;
                const statusCode = disconnectError?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed:', statusCode, '| reconnecting:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(() => loginBot(), 3000);
                }
            } else if (connection === 'open') {
                console.log('Connected to WhatsApp');
                isReady = true;
                latestQR = null;
                connectionState = 'open';
            }
        });

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('messages.update', (updates) => {
            for (const { key, update } of updates) {
                if (update.status === 3) {
                    console.log(`Delivered: ${key.id} -> ${key.remoteJid}`);
                } else if (update.status === 4) {
                    console.log(`Read: ${key.id} -> ${key.remoteJid}`);
                }
            }
        });

        whatsAppSocket = socket;
    } catch (error) {
        connectionState = 'error';
        console.log('Bot error:', error);
        setTimeout(() => loginBot(), 5000);
    }
}

loginBot();