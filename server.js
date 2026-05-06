const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { SerialPort } = require("serialport");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const SERIAL_PATH = process.env.SERIAL_PATH || "/dev/ttyUSB0";
const BAUD_RATE = Number(process.env.BAUD_RATE || 9600);

let port;

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

function readResponse(timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const p = ensurePort();
    let buf = "";
    const onData = d => {
      buf += d.toString("utf8");
      if (buf.includes("\r")) done(null, buf.trim());
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

async function queryCommand(cmd, timeoutMs = 300) {
  await writeCommand(cmd);
  await sleep(50);
  return readResponse(timeoutMs);
}

function zoneCmd(zone, suffix) {
  return `?${zone}${zone}${suffix}`;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/zone/:zone/power", async (req, res) => {
  const zone = Number(req.params.zone);
  const on = !!req.body.on;
  try {
    await writeCommand(`!${zone}${zone}P${on ? "1" : "0"}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/zone/:zone/source", async (req, res) => {
  const zone = Number(req.params.zone);
  const source = Number(req.body.source);
  try {
    await writeCommand(`!${zone}${zone}S${source}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/zone/:zone/volume", async (req, res) => {
  const zone = Number(req.params.zone);
  const volume = Number(req.body.volume);
  try {
    await writeCommand(`!${zone}${zone}V${volume}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/state", async (req, res) => {
  const zone = Number(req.query.zone);
  if (!zone || zone < 1 || zone > 6) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  try {
    const powerResp = await queryCommand(`?${zone}${zone}P`);
    const sourceResp = await queryCommand(`?${zone}${zone}S`);
    const volumeResp = await queryCommand(`?${zone}${zone}V`);

    res.json({
      zone,
      power: /1/.test(powerResp),
      source: Number((sourceResp.match(/\d+/) || [null])[0]),
      volume: Number((volumeResp.match(/\d+/) || [null])[0])
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Web UI running on http://0.0.0.0:${PORT}`);
});