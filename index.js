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

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PANEL_API_KEY;

let pairing = false;
let sessionReady = false;
let pairingCode = "";
let sessionId = "";

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>SUPREME KAI MD - Session Generator</title>
      <style>
        *{box-sizing:border-box}
        body{margin:0;background:#080808;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
        .card{width:100%;max-width:430px;background:#111;border:1px solid #292929;border-radius:15px;padding:25px}
        h2{text-align:center;margin-top:0}
        p{color:#aaa;text-align:center;font-size:14px}
        input,button,textarea{width:100%;padding:14px;margin-top:12px;border-radius:8px;border:1px solid #333;background:#080808;color:white;font-size:15px}
        button{background:white;color:black;font-weight:bold;border:0;cursor:pointer}
        textarea{height:130px;resize:vertical}
        #result{display:none}
        .note{font-size:12px;line-height:1.5}
      </style>
    </head>
    <body>
      <div class="card">
        <h2>SUPREME KAI MD</h2>
        <p>WhatsApp Session Generator</p>
        <input id="key" type="password" placeholder="Panel API key">
        <input id="number" type="tel" placeholder="WhatsApp number with country code">
        <button onclick="startPairing()">GET PAIRING CODE</button>
        <p id="status"></p>
        <div id="result">
          <textarea id="output" readonly placeholder="Your SESSION_ID will appear here"></textarea>
          <button onclick="copySession()">COPY SESSION ID</button>
        </div>
        <p class="note">Keep your SESSION_ID private. Anyone with it may access your WhatsApp account.</p>
      </div>
      <script>
        let job = "";
        async function startPairing(){
          const key = document.getElementById("key").value.trim();
          const number = document.getElementById("number").value.replace(/[^0-9]/g,"");
          const status = document.getElementById("status");
          if(!key || !number){status.textContent="Enter your panel key and WhatsApp number.";return;}
          status.textContent="Requesting pairing code...";
          document.getElementById("result").style.display="none";
          try{
            const response = await fetch("/api/pair",{
              method:"POST",
              headers:{"Content-Type":"application/json","x-api-key":key},
              body:JSON.stringify({number})
            });
            const data = await response.json();
            if(!response.ok) throw new Error(data.error || "Request failed");
            job = data.job;
            status.textContent="Pairing code: " + data.code + " — enter it in WhatsApp Linked Devices.";
            poll(key);
          }catch(error){status.textContent=error.message;}
        }
        async function poll(key){
          if(!job)return;
          try{
            const response = await fetch("/api/session/" + job,{
              headers:{"x-api-key":key}
            });
            const data = await response.json();
            if(data.ready){
              document.getElementById("output").value=data.sessionId;
              document.getElementById("result").style.display="block";
              document.getElementById("status").textContent="Session generated successfully.";
              job="";
              return;
            }
            if(data.error){document.getElementById("status").textContent=data.error;job="";return;}
            setTimeout(()=>poll(key),3000);
          }catch(error){
            document.getElementById("status").textContent="Connection error. Refresh and try again.";
            job="";
          }
        }
        async function copySession(){
          const output=document.getElementById("output");
          await navigator.clipboard.writeText(output.value);
          document.getElementById("status").textContent="SESSION_ID copied.";
        }
      </script>
    </body>
    </html>
  `);
});

function checkKey(req, res, next) {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid panel API key." });
  }
  next();
}

const jobs = new Map();

app.post("/api/pair", checkKey, async (req, res) => {
  if (pairing) return res.status(409).json({ error: "A pairing session is already running." });

  const number = String(req.body.number || "").replace(/\D/g, "");
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: "Enter a valid WhatsApp number with country code." });
  }

  pairing = true;
  sessionReady = false;
  pairingCode = "";
  sessionId = "";

  const job = Date.now().toString();
  const sessionDir = path.join(__dirname, "session-" + job);
  const state = { ready: false, sessionId: "", error: "" };
  jobs.set(job, state);

  res.json({ job, code: "Generating..." });

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: authState,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["SUPREME KAI MD", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    const code = await sock.requestPairingCode(number);
    state.code = code;
    pairingCode = code;

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        try {
          await new Promise(resolve => setTimeout(resolve, 1500));
          const archive = archiver("zip", { zlib: { level: 9 } });
          const chunks = [];
          archive.on("data", chunk => chunks.push(chunk));

          await new Promise((resolve, reject) => {
            archive.on("error", reject);
            archive.on("end", resolve);
            archive.directory(sessionDir, false);
            archive.finalize();
          });

          state.sessionId = "SUPREME-KAI-" + Buffer.concat(chunks).toString("base64");
          state.ready = true;
          sessionReady = true;
        } catch (error) {
          state.error = "Could not create session ID: " + error.message;
        } finally {
          pairing = false;
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut && !state.ready) {
          state.error = "WhatsApp connection closed. Please try again.";
        }
        pairing = false;
      }
    });
  } catch (error) {
    state.error = "Pairing failed: " + error.message;
    pairing = false;
  }
});

app.get("/api/session/:job", checkKey, (req, res) => {
  const state = jobs.get(req.params.job);
  if (!state) return res.status(404).json({ error: "Session request not found." });
  res.json(state);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SUPREME KAI MD Session Generator running on port " + PORT);
});
