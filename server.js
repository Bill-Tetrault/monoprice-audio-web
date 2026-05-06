'use strict';

/**
 * server.js – Monoprice 10761 RS-232 Web Controller
 *
 * CONFIRMED PROTOCOL (9600 8-N-1):
 *   Commands are terminated with \n (newline), NOT \r.
 *   Sending \r causes "Command Error." from the amp.
 *
 *   Query  : ?1<Z>\n          Z = zone 1-6  e.g. "?11\n"
 *   Set pwr: <1<Z>PR<00|01>\n
 *   Set src: <1<Z>CH<01-06>\n
 *   Set vol: <1<Z>VO<00-38>\n
 *
 *   Response: amp echoes command, sends '#' prompt, then reply starting with '>'.
 *   Full raw receive example: "?11\n#>1100000000111111100401"
 *
 *   We accumulate raw bytes and scan for '>' to extract the response.
 */

const express = require('express');
const path    = require('path');
const { SerialPort } = require('serialport');

const PORT        = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH   || '/dev/ttyUSB0';
const BAUD_RATE   = 9600;
const CONTROLLER_ID = 1;   // change to 2/3 for chained units
const REPLY_TIMEOUT = 3000; // ms

// ── Serial port (raw Buffer mode – no parser) ─────────────────────────────────
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

// ── Zone ID helper ────────────────────────────────────────────────────────────
// Confirmed: ?1<Z> single-digit zone (1-6)  e.g. "?11" for zone 1
// Change to `${CONTROLLER_ID}${zone}` if your firmware uses 11-16 format.
function zoneId(zone) {
  return `${zone}`;
}

// ── Core serial transaction ───────────────────────────────────────────────────
/**
 * sendCommand(cmd) → Promise<string>
 *
 * Writes cmd + \n (CONFIRMED working terminator for 10761).
 * Accumulates all incoming bytes and resolves with the first line
 * starting with '>' — immune to echo, '#' prompts, and extra bytes.
 */
function sendCommand(cmd) {
  serialQueue = serialQueue.then(() => _doSend(cmd));
  return serialQueue;
}

function _doSend(cmd) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let timer;

    function onData(chunk) {
      buf += chunk.toString('ascii');

      // Scan for response: starts with '>'
      const start = buf.indexOf('>');
      if (start === -1) return; // not yet received

      // Grab everything from '>' to end of current buffer
      // (response may not have a clean terminator – grab what we have
      //  once we see '>' and the buffer stops growing, or hits \r or \n)
      const rest = buf.slice(start);
      const end  = rest.search(/[\r\n]/);

      if (end !== -1) {
        // Clean terminator found
        cleanup();
        resolve(rest.slice(0, end).trim());
      } else if (rest.length >= 20) {
        // No terminator but we have enough data (min response is ~22 chars)
        cleanup();
        resolve(rest.trim());
      }
      // else keep accumulating
    }

    function onError(err) { cleanup(); reject(err); }

    function cleanup() {
      clearTimeout(timer);
      serial.removeListener('data', onData);
      serial.removeListener('error', onError);
    }

    serial.on('data', onData);
    serial.on('error', onError);

    timer = setTimeout(() => {
      cleanup();
      const hint = buf
        ? ` (received: ${JSON.stringify(buf)})`
        : ' (nothing received – check cable/path/permissions)';
      reject(new Error(`Serial timeout for "${cmd}"${hint}`));
    }, REPLY_TIMEOUT);

    // IMPORTANT: terminate with \n, not \r
    serial.write(cmd + '\r', 'ascii', (writeErr) => {
      if (writeErr) { cleanup(); reject(writeErr); return; }
      serial.drain((drainErr) => {
        if (drainErr) { cleanup(); reject(drainErr); }
      });
    });
  });
}

// ── Protocol helpers ──────────────────────────────────────────────────────────

/**
 * parseZoneStatus(raw, zone)
 *
 * raw example: ">1100000000111111100401"
 *
 * Strip '>', split into 2-char pairs:
 *   idx  field
 *    0   ZZ  (zone echo)
 *    1   PA
 *    2   PR  ← power (0=off, 1=on)
 *    3   MU
 *    4   DT
 *    5   VO  ← volume (00-38)
 *    6   TR
 *    7   BS
 *    8   BL
 *    9   CH  ← source/channel (01-06)
 *   10   LS
 *
 * Adjust field indices here if your firmware packs fields differently.
 */
function parseZoneStatus(raw, zone) {
  const data = raw.replace(/^>/, '').trim();

  const fields = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    fields.push(parseInt(data.slice(i, i + 2), 10));
  }

  if (fields.length < 10) {
    throw new Error(`Short response: "${raw}" – only ${fields.length} fields parsed`);
  }

  return {
    zone,
    power:  fields[2] === 1,  // PR
    volume: fields[5],         // VO
    source: fields[9],         // CH
  };
}

async function getZoneState(zone) {
  const cmd   = `?${CONTROLLER_ID}${zoneId(zone)}`;
  const reply = await sendCommand(cmd);
  return parseZoneStatus(reply, zone);
}

async function setZonePower(zone, on) {
  const cmd = `<${CONTROLLER_ID}${zoneId(zone)}PR${on ? '01' : '00'}`;
  await sendCommand(cmd);
}

async function setZoneSource(zone, source) {
  const val = String(source).padStart(2, '0');
  const cmd = `<${CONTROLLER_ID}${zoneId(zone)}CH${val}`;
  await sendCommand(cmd);
}

async function setZoneVolume(zone, volume) {
  const clamped = Math.max(0, Math.min(38, volume));
  const val     = String(clamped).padStart(2, '0');
  const cmd     = `<${CONTROLLER_ID}${zoneId(zone)}VO${val}`;
  await sendCommand(cmd);
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
    console.error('Check SERIAL_PATH env var and that your user is in the dialout group.');
    process.exit(1);
  }
  console.log(`Serial open: ${SERIAL_PATH} @ ${BAUD_RATE} baud`);
  app.listen(PORT, () => {
    console.log(`Monoprice controller ready → http://0.0.0.0:${PORT}`);
  });
});

serial.on('error', (err) => console.error('Serial error:', err.message));
