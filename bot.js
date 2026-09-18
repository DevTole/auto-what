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
let lastConnectedAt = null;

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
    res.json({
        status: 'ok',
        whatsappReady: isReady,
        connectionState,
        lastConnectedAt,
    });
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', whatsappReady: isReady });
});

app.get('/qr', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (isReady) {
        return res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Bot</title>
<script type="module" src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.esm.js"></script>
<script nomodule src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.js"></script>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#0b141a; color:#e9edef; }
  .box { text-align:center; padding:36px 32px; border-radius:18px; background:#111b21; box-shadow:0 10px 30px rgba(0,0,0,.4); max-width:420px; width:90%; }
  .icon-wrap { display:inline-flex; align-items:center; justify-content:center; width:72px; height:72px; border-radius:50%; background:rgba(37,211,102,.12); margin-bottom:12px; }
  ion-icon { font-size:44px; color:#25d366; }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:8px 0; color:#8696a0; font-size:14px; line-height:1.5; }
  .meta { margin-top:14px; font-size:12px; color:#5c6b73; }
</style>
</head>
<body>
<div class="box">
  <div class="icon-wrap"><ion-icon name="checkmark-circle-outline"></ion-icon></div>
  <h1>WhatsApp is connected</h1>
  <p>No QR needed. The bot is ready to send messages.</p>
  <div class="meta">Connected at: ${lastConnectedAt ?? 'unknown'}</div>
</div>
<script>
  if (Notification.permission === 'granted') {
    new Notification('WhatsApp bot connected');
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification('WhatsApp bot connected');
    });
  }
</script>
</body>
</html>`);
    }

    if (!latestQR) {
        return res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>WhatsApp Bot</title>
<script type="module" src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.esm.js"></script>
<script nomodule src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.js"></script>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#0b141a; color:#e9edef; }
  .box { text-align:center; padding:36px 32px; border-radius:18px; background:#111b21; box-shadow:0 10px 30px rgba(0,0,0,.4); max-width:420px; width:90%; }
  .icon-wrap { display:inline-flex; align-items:center; justify-content:center; width:72px; height:72px; border-radius:50%; background:rgba(134,150,160,.12); margin-bottom:12px; }
  ion-icon { font-size:44px; color:#8696a0; animation:spin 2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:8px 0; color:#8696a0; font-size:14px; }
  .state { color:#e9edef; font-weight:600; }
</style>
</head>
<body>
<div class="box">
  <div class="icon-wrap"><ion-icon name="sync-outline"></ion-icon></div>
  <h1>Waiting for QR</h1>
  <p>Connection state: <span class="state">${connectionState}</span></p>
  <p>This page refreshes automatically.</p>
</div>
</body>
</html>`);
    }

    try {
        const dataUrl = await QRCode.toDataURL(latestQR, {
            width: 360,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });

        return res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>Scan WhatsApp QR</title>
<script type="module" src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.esm.js"></script>
<script nomodule src="https://unpkg.com/ionicons@7.1.0/dist/ionicons/ionicons.js"></script>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#0b141a; color:#e9edef; padding:20px; box-sizing:border-box; }
  .box { text-align:center; padding:36px 32px; border-radius:18px; background:#111b21; box-shadow:0 10px 30px rgba(0,0,0,.4); max-width:440px; width:100%; }
  .icon-wrap { display:inline-flex; align-items:center; justify-content:center; width:72px; height:72px; border-radius:50%; background:rgba(37,211,102,.12); margin-bottom:12px; }
  ion-icon { font-size:44px; color:#25d366; }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:8px 0; color:#8696a0; font-size:14px; }
  img { width:100%; max-width:340px; border-radius:12px; background:#fff; padding:12px; margin-top:12px; }
  .steps { text-align:left; display:inline-block; margin-top:16px; color:#8696a0; font-size:13px; line-height:1.8; }
  .steps ion-icon { font-size:16px; vertical-align:-3px; margin-right:6px; color:#25d366; }
</style>
</head>
<body>
<div class="box">
  <div class="icon-wrap"><ion-icon name="qr-code-outline"></ion-icon></div>
  <h1>Scan to connect WhatsApp</h1>
  <p>This QR refreshes automatically every 20 seconds.</p>
  <img src="${dataUrl}" alt="WhatsApp QR" />
  <div class="steps">
    <div><ion-icon name="phone-portrait-outline"></ion-icon>Open WhatsApp on your phone</div>
    <div><ion-icon name="settings-outline"></ion-icon>Tap Settings, then Linked Devices</div>
    <div><ion-icon name="link-outline"></ion-icon>Tap Link a Device</div>
    <div><ion-icon name="scan-outline"></ion-icon>Scan this QR</div>
  </div>
</div>
</body>
</html>`);
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

app.post('/send_message', async (req, res) => {
    const { phone_number, message } = req.body || {};

    const body = message === undefined || message === null
        ? ''
        : String(message);

    if (!body.trim()) {
        return res.status(400).json({ error: 'message is required' });
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

        const sent = await whatsAppSocket.sendMessage(targetJid, { text: body });

        return res.json({
            sent: true,
            messageId: sent?.key?.id ?? null,
            to: targetJid,
        });
    } catch (error) {
        console.error('Failed to send message:', error?.message ?? error);
        return res.status(502).json({ error: 'Unable to send the message' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${port}`);
});

async function notifyConnect(socket) {
    lastConnectedAt = new Date().toISOString();

    try {
        const selfJid = socket.user?.id;
        if (selfJid) {
            await socket.sendMessage(selfJid, {
                text: `*Bot connected successfully*\n\nTime: ${lastConnectedAt}`,
            });
            console.log('Self-notification sent to', selfJid);
        }
    } catch (err) {
        console.error('Self-notify failed:', err?.message ?? err);
    }

    const url = process.env.CONNECT_WEBHOOK_URL;
    if (url) {
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `*WhatsApp bot connected*\n\nTime: ${lastConnectedAt}`,
                }),
            });
            console.log('Webhook notification sent');
        } catch (err) {
            console.error('Webhook notify failed:', err?.message ?? err);
        }
    }
}

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

        socket.ev.on('connection.update', async (update) => {
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
                await notifyConnect(socket);
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