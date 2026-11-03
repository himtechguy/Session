const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PANEL_API_KEY;

const jobs = new Map();
let pairing = false;

function checkKey(req, res, next) {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid panel API key." });
  }
  next();
}

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SUPREME KAI MD</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#080808;color:white;font-family:Arial;display:grid;place-items:center;min-height:100vh;padding:20px}
.card{width:100%;max-width:430px;background:#111;border:1px solid #333;border-radius:15px;padding:24px}
h2{text-align:center}
p{text-align:center;color:#aaa;font-size:14px}
input,button,textarea{width:100%;padding:14px;margin-top:12px;border-radius:8px;border:1px solid #333;background:#080808;color:white;font-size:15px}
button{background:white;color:black;font-weight:bold;border:0}
.methods{display:flex;gap:10px}
.methods button{width:50%}
#qr{display:none;width:220px;height:220px;background:white;padding:8px;margin:18px auto;border-radius:8px}
#result{display:none}
textarea{height:120px}
.note{font-size:12px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<h2>SUPREME KAI MD</h2>
<p>WhatsApp Session Generator</p>

<input id="key" type="password" placeholder="Panel API key">
<input id="number" type="tel" placeholder="WhatsApp number with country code">

<div class="methods">
<button onclick="start('pair')">PAIR CODE</button>
<button onclick="start('qr')">QR CODE</button>
</div>

<p id="status">Choose your connection method.</p>
<img id="qr">
<div id="result">
<textarea id="output" readonly></textarea>
<button onclick="copySession()">COPY SESSION ID</button>
</div>

<p class="note">Keep your SESSION_ID private. Anyone with it may access your WhatsApp account.</p>
</div>

<script>
let job = "";
let timer = null;

async function start(method) {
  const key = document.getElementById("key").value.trim();
  const number = document.getElementById("number").value.replace(/\\D/g,"");
  const status = document.getElementById("status");

  if (!key) {
    status.textContent = "Enter your panel API key.";
    return;
  }

  if (method === "pair" && (number.length < 8 || number.length > 15)) {
    status.textContent = "Enter a valid WhatsApp number with country code.";
    return;
  }

  clearTimeout(timer);
  job = "";
  document.getElementById("qr").style.display = "none";
  document.getElementById("result").style.display = "none";
  status.textContent = "Starting...";

  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key
      },
      body: JSON.stringify({ method, number })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    job = data.job;
    status.textContent = "Connecting to WhatsApp...";
    poll(key);
  } catch (error) {
    status.textContent = error.message || "Could not start.";
  }
}

async function poll(key) {
  if (!job) return;

  try {
    const response = await fetch("/api/session/" + job, {
      headers: { "x-api-key": key }
    });

    const data = await response.json();

    if (data.error) {
      document.getElementById("status").textContent = data.error;
      job = "";
      return;
    }

    if (data.code) {
      document.getElementById("status").textContent =
        "Your pairing code: " + data.code +
        " — enter it in WhatsApp Linked Devices.";
    }

    if (data.qr) {
      const qr = document.getElementById("qr");
      qr.src = data.qr;
      qr.style.display = "block";
      document.getElementById("status").textContent =
        "Scan this QR code using WhatsApp Linked Devices.";
    }

    if (data.ready) {
      document.getElementById("output").value = data.sessionId;
      document.getElementById("result").style.display = "block";
      document.getElementById("status").textContent =
        "Session generated successfully.";
      job = "";
      return;
    }

    timer = setTimeout(() => poll(key), 2000);
  } catch (error) {
    document.getElementById("status").textContent = "Connection error.";
    job = "";
  }
}

async function copySession() {
  const value = document.getElementById("output").value;
  await navigator.clipboard.writeText(value);
  document.getElementById("status").textContent = "SESSION_ID copied.";
}
</script>
</body>
</html>
  `);
});

app.post("/api/pair", checkKey, async (req, res) => {
  if (pairing) {
    return res.status(409).json({
      error: "A pairing session is already running."
    });
  }

  const method = req.body.method;
  const number = String(req.body.number || "").replace(/\D/g, "");

  if (!["pair", "qr"].includes(method)) {
    return res.status(400).json({ error: "Invalid method." });
  }

  if (method === "pair" && (number.length < 8 || number.length > 15)) {
    return res.status(400).json({ error: "Invalid WhatsApp number." });
  }

  pairing = true;

  const job = Date.now().toString();
  const sessionDir = path.join(__dirname, "session-" + job);

  const state = {
    ready: false,
    code: "",
    qr: "",
    sessionId: "",
    error: ""
  };

  jobs.set(job, state);
  res.json({ job });

  let sock;

  try {
    const { state: authState, saveCreds } =
      await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: authState,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["SUPREME KAI MD", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr && method === "qr") {
        try {
          state.qr = await QRCode.toDataURL(qr);
        } catch (error) {
          state.error = "Could not generate QR code.";
        }
      }

      if (connection === "open" && !state.ready) {
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));

          const archive = archiver("zip", {
            zlib: { level: 9 }
          });

          const chunks = [];
          archive.on("data", chunk => chunks.push(chunk));

          await new Promise((resolve, reject) => {
            archive.on("error", reject);
            archive.on("end", resolve);
            archive.directory(sessionDir, false);
            archive.finalize();
          });

          state.sessionId =
            "SUPREME-KAI-" +
            Buffer.concat(chunks).toString("base64");

          state.ready = true;
        } catch (error) {
          state.error = "Session creation failed: " + error.message;
        } finally {
          pairing = false;
        }
      }

      if (connection === "close" && !state.ready) {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        state.error =
          statusCode === DisconnectReason.loggedOut
            ? "WhatsApp logged out. Try again."
            : "Connection closed. Please try again.";

        pairing = false;
      }
    });

    if (method === "pair") {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const code = await sock.requestPairingCode(number);
      state.code = code;
    }

  } catch (error) {
    state.error = "Pairing failed: " + error.message;
    pairing = false;

    if (sock) {
      try {
        sock.end(error);
      } catch {}
    }
  }
});

app.get("/api/session/:job", checkKey, (req, res) => {
  const state = jobs.get(req.params.job);

  if (!state) {
    return res.status(404).json({ error: "Session request not found." });
  }

  res.json(state);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SUPREME KAI MD Session Generator running on port " + PORT);
});
