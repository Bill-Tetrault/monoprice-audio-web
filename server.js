const express = require("express");
const cors = require("cors");
const { SerialPort } = require("serialport");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const SERIAL_PATH = process.env.SERIAL_PATH || "/dev/ttyUSB0";
const BAUD_RATE = Number(process.env.BAUD_RATE || 9600);

let port;

// Simple delay
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function openPort() {
  port = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD_RATE, autoOpen: false });
  port.open(err => {
    if (err) console.error("Serial open error:", err.message);
    else console.log(`Connected to ${SERIAL_PATH} @ ${BAUD_RATE}`);
  });
}

openPort();

function ensurePort() {
  if (!port) throw new Error("Serial port not initialized");
  return port;
}

function writeCommand(cmd) {
  return new Promise((resolve, reject) => {
    const p = ensurePort();
    if (!p.writable) return reject(new Error("Serial port not writable"));
    p.write(cmd + "\r", err => {
      if (err) return reject(err);
      p.drain(err2 => (err2 ? reject(err2) : resolve()));
    });
  });
}

function readResponse(timeoutMs = 400) {
  return new Promise((resolve, reject) => {
    const p = ensurePort();
    let buf = "";
    const onData = d => {
      buf += d.toString("utf8");
      if (buf.includes("\r") || buf.includes("\n")) done(null, buf.trim());
    };
    const timer = setTimeout(() => done(null, buf.trim()), timeoutMs);

    function done(err, value) {
      clearTimeout(timer);
      p.off("data", onData);
      err ? reject(err) : resolve(value);
    }

    p.on("data", onData);
  });
}

// Send a query and read a single line back
async function queryCommand(cmd, timeoutMs = 400) {
  await writeCommand(cmd);
  await sleep(60);
  return readResponse(timeoutMs);
}

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Power control: on/off
app.post("/api/zone/:zone/power", async (req, res) => {
  const zone = Number(req.params.zone);
  const on = !!req.body.on;
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  try {
    // Example: !ZZP1 for on, !ZZP0 for off – adjust to your protocol
    const cmd = `!${zone}${zone}P${on ? "1" : "0"}`;
    await writeCommand(cmd);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Source control: 1–6
app.post("/api/zone/:zone/source", async (req, res) => {
  const zone = Number(req.params.zone);
  const source = Number(req.body.source);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: "Invalid zone" });
  }
  if (!Number.isFinite(source) || source < 1 || source > 6) {
    return res.status(400).json({ error: "Invalid source" });
  }

  try {
    // Example: !ZZSx – adjust to your protocol
    const cmd = `!${zone}${zone}S${source}`;
    await writeCommand(cmd);
    res.json({ ok: true, source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Volume control: 1–38
app.post("/api/zone/:zone/volume", async (req, res) => {
  const zone = Number(req.params.zone);
  let volume = Number(req.body.volume);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: "Invalid zone" });
  }
  if (!Number.isFinite(volume)) {
    return res.status(400).json({ error: "Invalid volume" });
  }
  if (volume < 1) volume = 1;
  if (volume > 38) volume = 38;

  try {
    // Example: !ZZVnn where nn = 1–38 – adjust to your protocol
    const cmd = `!${zone}${zone}V${volume}`;
    await writeCommand(cmd);
    res.json({ ok: true, volume });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// State polling: power, source, volume
app.get("/api/state", async (req, res) => {
  const zone = Number(req.query.zone);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  try {
    // These queries and regexes are examples. Adjust to match your manual.
    const powerResp  = await queryCommand(`?${zone}${zone}P`);
    const sourceResp = await queryCommand(`?${zone}${zone}S`);
    const volumeResp = await queryCommand(`?${zone}${zone}V`);

    // Example response formats:
    //   "11P1" (zone 1 power on)
    //   "11S3" (zone 1 source 3)
    //   "11V14" (zone 1 volume 14)
    const pMatch  = powerResp.match(/P(\d+)/i);
    const sMatch  = sourceResp.match(/S(\d+)/i);
    const vMatch  = volumeResp.match(/V(\d+)/i);

    const power  = pMatch ? pMatch[1] === "1" : null;
    const source = sMatch ? Number(sMatch[1]) : null;
    const volume = vMatch ? Number(vMatch[1]) : null;

    res.json({ zone, power, source, volume });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Monoprice web UI listening on http://0.0.0.0:${PORT}`);
});