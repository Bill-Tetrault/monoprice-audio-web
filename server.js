'use strict';

/**
 * server.js – Monoprice 10761 RS-232 Web Controller
 *
 * CONFIRMED PROTOCOL (9600 8-N-1):
 *   Terminator : \r\n
 *   Query cmds : expect a ">" response line  e.g. ?11\r\n → >1100000000111111100401
 *   Set cmds   : NO response – amp silently executes  e.g. <14PR01\r\n → (nothing)
 *
 *   Query  : ?1<Z>\r\n          Z = zone 1-6
 *   Set pwr: <1<Z>PR<00|01>\r\n
 *   Set src: <1<Z>CH<01-06>\r\n
 *   Set vol: <1<Z>VO<00-38>\r\n
 */

const express = require('express');
const path    = require('path');
const { SerialPort } = require('serialport');

const PORT          = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH   = process.env.SERIAL_PATH   || '/dev/ttyUSB0';
const BAUD_RATE     = 9600;
const CONTROLLER_ID = 1;
const REPLY_TIMEOUT = 4000; // ms – for query commands only

// ── Serial port (raw Buffer mode) ─────────────────────────────────────────────
const serial = new SerialPort({
  path:     SERIAL_PATH,
  baudRate: BAUD_RATE,
  dataBits: 8,
  parity:   'none',
  stopBits: 1,
  autoOpen: false,
});

// One transaction at a time
let serialQueue = Promise.resolve();

function zoneId(zone) { return `${zone}`; }

// ── Write-only command (set power/source/volume – no response expected) ────────
/**
 * writeCommand(cmd) → Promise<void>
 * Writes cmd + \r\n and resolves after drain. Does NOT wait for any response.
 */
function writeCommand(cmd) {
  serialQueue = serialQueue.then(() => _doWrite(cmd));
  return serialQueue;
}

function _doWrite(cmd) {
  return new Promise((resolve, reject) => {
    serial.write(cmd + '\r\n', 'ascii', (err) => {
      if (err) return reject(err);
      serial.drain((err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

// ── Query command (expects ">" response) ──────────────────────────────────────
/**
 * queryCommand(cmd) → Promise<string>
 * Writes cmd + \r\n and waits for a response line starting with '>'.
 * Accumulates raw bytes; resolves 200ms after buffer stops growing once '>' is seen.
 */
function queryCommand(cmd) {
  serialQueue = serialQueue.then(() => _doQuery(cmd));
  return serialQueue;
}

function _doQuery(cmd) {
  return new Promise((resolve, reject) => {
    let buf         = '';
    let settleTimer = null;
    let timeoutTimer;

    function tryResolve() {
      const start = buf.indexOf('>');
      if (start === -1) return false;
      const line = buf.slice(start).replace(/[\r\n]+$/, '').trim();
      if (line.length < 3) return false;
      cleanup();
      resolve(line);
      return true;
    }

    function onData(chunk) {
      buf += chunk.toString('ascii');
      clearTimeout(settleTimer);
      if (buf.indexOf('>') !== -1) {
        settleTimer = setTimeout(() => {
          if (!tryResolve()) {
            cleanup();
            reject(new Error(`Incomplete response for "${cmd}": ${JSON.stringify(buf)}`));
          }
        }, 200);
      }
    }

    function onError(err) { cleanup(); reject(err); }

    function cleanup() {
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      serial.removeListener('data', onData);
      serial.removeListener('error', onError);
    }

    serial.on('data', onData);
    serial.on('error', onError);

    timeoutTimer = setTimeout(() => {
      cleanup();
      const hint = buf
        ? ` (received: ${JSON.stringify(buf)})`
        : ' (nothing received – check cable/path/permissions)';
      reject(new Error(`Serial timeout for "${cmd}"${hint}`));
    }, REPLY_TIMEOUT);

    serial.write(cmd + '\r\n', 'ascii', (writeErr) => {
      if (writeErr) { cleanup(); reject(writeErr); return; }
      serial.drain((drainErr) => {
        if (drainErr) { cleanup(); reject(drainErr); }
      });
    });
  });
}

// ── Response parser ───────────────────────────────────────────────────────────
/**
 * parseZoneStatus(raw, zone)
 * raw example: ">1100000000111111100401"
 * 2-char fields after '>':
 *   0=ZZ  1=PA  2=PR(power 0/1)  3=MU  4=DT  5=VO(0-38)
 *   6=TR  7=BS  8=BL  9=CH(source 1-6)  10=LS
 */
function parseZoneStatus(raw, zone) {
  const data = raw.replace(/^>/, '').trim();
  const fields = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    fields.push(parseInt(data.slice(i, i + 2), 10));
  }
  if (fields.length < 10) {
    throw new Error(`Short response: "${raw}" (${fields.length} fields)`);
  }
  return {
    zone,
    power:  fields[2] === 1,
    volume: fields[5],
    source: fields[9],
  };
}

// ── Protocol functions ────────────────────────────────────────────────────────
async function getZoneState(zone) {
  const reply = await queryCommand(`?${CONTROLLER_ID}${zoneId(zone)}`);
  return parseZoneStatus(reply, zone);
}

// Set commands use writeCommand – no response expected
async function setZonePower(zone, on) {
  await writeCommand(`<${CONTROLLER_ID}${zoneId(zone)}PR${on ? '01' : '00'}`);
}

async function setZoneSource(zone, source) {
  await writeCommand(`<${CONTROLLER_ID}${zoneId(zone)}CH${String(source).padStart(2, '0')}`);
}

async function setZoneVolume(zone, volume) {
  const v = Math.max(0, Math.min(38, volume));
  await writeCommand(`<${CONTROLLER_ID}${zoneId(zone)}VO${String(v).padStart(2, '0')}`);
}

// ── Validation ────────────────────────────────────────────────────────────────
function validZone(z)   { return Number.isInteger(z) && z >= 1 && z <= 6; }
function validSource(s) { return Number.isInteger(s) && s >= 1 && s <= 6; }

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, serial: SERIAL_PATH, connected: serial.isOpen });
});

app.get('/api/state', async (req, res) => {
  const zone = parseInt(req.query.zone, 10);
  if (!validZone(zone)) return res.status(400).json({ error: 'zone must be 1-6' });
  try {
    res.json(await getZoneState(zone));
  } catch (err) {
    console.error('GET /api/state:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zone/:zone/power', async (req, res) => {
  const zone = parseInt(req.params.zone, 10);
  const { on } = req.body;
  if (!validZone(zone))        return res.status(400).json({ error: 'zone must be 1-6' });
  if (typeof on !== 'boolean') return res.status(400).json({ error: '"on" must be boolean' });
  try {
    await setZonePower(zone, on);
    res.json({ ok: true, zone, power: on });
  } catch (err) {
    console.error('POST /power:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zone/:zone/source', async (req, res) => {
  const zone   = parseInt(req.params.zone, 10);
  const source = parseInt(req.body.source, 10);
  if (!validZone(zone))     return res.status(400).json({ error: 'zone must be 1-6' });
  if (!validSource(source)) return res.status(400).json({ error: 'source must be 1-6' });
  try {
    await setZoneSource(zone, source);
    res.json({ ok: true, zone, source });
  } catch (err) {
    console.error('POST /source:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zone/:zone/volume', async (req, res) => {
  const zone   = parseInt(req.params.zone, 10);
  const volume = parseInt(req.body.volume, 10);
  if (!validZone(zone)) return res.status(400).json({ error: 'zone must be 1-6' });
  if (isNaN(volume))    return res.status(400).json({ error: '"volume" must be a number' });
  const clamped = Math.max(0, Math.min(38, volume));
  try {
    await setZoneVolume(zone, clamped);
    res.json({ ok: true, zone, volume: clamped });
  } catch (err) {
    console.error('POST /volume:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Open serial then start HTTP ───────────────────────────────────────────────
serial.open((err) => {
  if (err) {
    console.error(`Cannot open ${SERIAL_PATH}:`, err.message);
    process.exit(1);
  }
  console.log(`Serial open: ${SERIAL_PATH} @ ${BAUD_RATE} baud`);
  app.listen(PORT, () => console.log(`Monoprice controller → http://0.0.0.0:${PORT}`));
});

serial.on('error', (err) => console.error('Serial error:', err.message));
