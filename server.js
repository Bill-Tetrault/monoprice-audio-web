'use strict';

/**
 * server.js – Monoprice 10761 RS-232 Web Controller
 *
 * PROTOCOL REFERENCE (model 10761, 9600 8-N-1):
 *   Query zone status  : ?1<ZZ>\r          ZZ = 11-16 (zone 1-6)
 *   Response example   : >1100010000xxxxxx\r\n
 *     Positions (0-based in the data portion after '>'):
 *       [0-1] controller+zone id  e.g. "11"
 *       [2-3] public address (PA) flag
 *       [4-5] power  (PR)  00=off 01=on
 *       [6-7] mute   (MU)  00/01
 *       [8-9] do not disturb (DT)
 *       [10-11] volume (VO)  00-38
 *       [12-13] treble (TR)
 *       [14-15] bass   (BS)
 *       [16-17] balance(BL)
 *       [18-19] source (CH)  01-06
 *       [20-21] keypad flag (LS)
 *
 *   Set power  : <1<ZZ>PR<00|01>\r
 *   Set source : <1<ZZ>CH<01-06>\r
 *   Set volume : <1<ZZ>VO<00-38>\r
 *
 *   NOTE: The amp echoes every command byte back before sending the response.
 *         We drain the echo and then read the actual reply line.
 *
 *   If your firmware returns zone numbers as single digits (1-6 instead of
 *   11-16), change ZONE_PREFIX below from '' to '' and adjust zoneId().
 */

const express = require('express');
const path    = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3000', 10);
const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/ttyUSB0';
const BAUD_RATE   = 9600;

/**
 * The 10761 uses a two-digit zone identifier where the first digit is the
 * controller number (1) and the second is the zone (1-6), giving 11-16.
 * Change CONTROLLER_ID if you have chained controllers (1,2,3...).
 */
const CONTROLLER_ID = 1;

// ─── Serial port setup ────────────────────────────────────────────────────────
const serial = new SerialPort({
  path:     SERIAL_PATH,
  baudRate: BAUD_RATE,
  dataBits: 8,
  parity:   'none',
  stopBits: 1,
  autoOpen: false,
});

const parser = serial.pipe(new ReadlineParser({ delimiter: '\r\n' }));

// Queue so we never interleave serial transactions
let serialQueue = Promise.resolve();

/** Build the two-digit zone string used in every command, e.g. "11" for zone 1 */
function zoneId(zone) {
  return `${CONTROLLER_ID}${zone}`;
}

/**
 * sendCommand(cmd) → Promise<string>
 * Writes `cmd + \r` to the serial port, discards the echo, and resolves with
 * the first non-empty, non-echo line returned by the amp.
 *
 * The 10761 echoes every sent byte.  A status query reply starts with '>'.
 * A set-command acknowledgement also starts with '>'.  We wait up to
 * REPLY_TIMEOUT ms for a line starting with '>'.
 */
const REPLY_TIMEOUT = 2000; // ms

function sendCommand(cmd) {
  // Serialise access – one transaction at a time
  serialQueue = serialQueue.then(() => _doSend(cmd));
  return serialQueue;
}

function _doSend(cmd) {
  return new Promise((resolve, reject) => {
    const raw = cmd + '\r';
    let   timer;

    const onData = (line) => {
      line = line.trim();
      // Skip empty lines and echo lines (echoed chars will not start with '>')
      if (!line || !line.startsWith('>')) return;
      cleanup();
      resolve(line);
    };

    const onError = (err) => { cleanup(); reject(err); };

    function cleanup() {
      clearTimeout(timer);
      parser.removeListener('data', onData);
      serial.removeListener('error', onError);
    }

    parser.on('data', onData);
    serial.on('error', onError);

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Serial timeout waiting for response to "${cmd}"`));
    }, REPLY_TIMEOUT);

    serial.write(raw, 'ascii', (err) => {
      if (err) { cleanup(); reject(err); }
      // flush ensures bytes are sent before we wait for reply
      serial.drain((err2) => { if (err2) { cleanup(); reject(err2); } });
    });
  });
}

// ─── Protocol helpers ─────────────────────────────────────────────────────────

/**
 * queryZone(zone) → Promise<{ zone, power, source, volume }>
 *
 * Sends  ?1<ZZ>\r  (e.g. ?111\r for zone 1)
 * Parses response: >ZZPAMUPRDTVOTRB SBLCHLS
 *   We care about offsets (1-based in the data after '>'):
 *     pos 2-3  → ignored (zone echo)  ← actually pos 0-1
 *     pos 4-5  → PR  (power)
 *     pos 10-11→ VO  (volume)
 *     pos 18-19→ CH  (source/channel)
 *
 * Raw response example for zone 1, power on, source 2, volume 15:
 *   >1100010000150000001300201
 *   >ZZPAPRMUDTVOTRBSBLCHLSpd
 *    0123456789012345678901234
 *              1111111111222222
 *
 * NOTE: some firmware versions include a trailing checksum byte. The regex
 *       below is flexible enough to handle both.
 */
function parseZoneStatus(raw, zone) {
  // Remove the leading '>'
  const data = raw.replace(/^>/, '');

  // Each field is exactly 2 decimal digits.
  // Field order: ZZ PA PR MU DT VO TR BS BL CH LS [optional extra]
  const fields = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    fields.push(parseInt(data.slice(i, i + 2), 10));
  }
  // fields[0] = zone id (e.g. 11)
  // fields[1] = PA
  // fields[2] = PR  ← power
  // fields[3] = MU
  // fields[4] = DT
  // fields[5] = VO  ← volume
  // fields[6] = TR
  // fields[7] = BS
  // fields[8] = BL
  // fields[9] = CH  ← source/channel
  // fields[10]= LS

  if (fields.length < 10) {
    throw new Error(`Unexpected response format: "${raw}"`);
  }

  return {
    zone,
    power:  fields[2] === 1,
    volume: fields[5],   // 0-38
    source: fields[9],   // 1-6
  };
}

/** Query current state of a zone (1-6) */
async function getZoneState(zone) {
  // Query command: ?1<ZZ>  e.g. "?111" for zone 1
  const cmd = `?1${zoneId(zone)}`;
  const reply = await sendCommand(cmd);
  return parseZoneStatus(reply, zone);
}

/** Power a zone on (true) or off (false) */
async function setZonePower(zone, on) {
  // <1<ZZ>PR00  or  <1<ZZ>PR01
  const val = on ? '01' : '00';
  const cmd = `<1${zoneId(zone)}PR${val}`;
  await sendCommand(cmd);
}

/** Set source (channel) for a zone; source is 1-6, zero-padded to 2 digits */
async function setZoneSource(zone, source) {
  const val = String(source).padStart(2, '0');
  const cmd = `<1${zoneId(zone)}CH${val}`;
  await sendCommand(cmd);
}

/**
 * Set volume for a zone; volume is 0-38, clamped server-side.
 * The amp accepts 00-38; 00 is muted/silent, 38 is maximum.
 */
async function setZoneVolume(zone, volume) {
  const clamped = Math.max(0, Math.min(38, volume));
  const val = String(clamped).padStart(2, '0');
  const cmd = `<1${zoneId(zone)}VO${val}`;
  await sendCommand(cmd);
}

// ─── Validation helpers ───────────────────────────────────────────────────────
function validZone(z)   { return Number.isInteger(z) && z >= 1 && z <= 6; }
function validSource(s) { return Number.isInteger(s) && s >= 1 && s <= 6; }

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, serial: SERIAL_PATH, connected: serial.isOpen });
});

// GET /api/state?zone=N
app.get('/api/state', async (req, res) => {
  const zone = parseInt(req.query.zone, 10);
  if (!validZone(zone)) {
    return res.status(400).json({ error: 'zone must be 1-6' });
  }
  try {
    const state = await getZoneState(zone);
    res.json(state);
  } catch (err) {
    console.error('GET /api/state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zone/:zone/power   body: { on: true|false }
app.post('/api/zone/:zone/power', async (req, res) => {
  const zone = parseInt(req.params.zone, 10);
  if (!validZone(zone)) return res.status(400).json({ error: 'zone must be 1-6' });

  const { on } = req.body;
  if (typeof on !== 'boolean') return res.status(400).json({ error: '"on" must be boolean' });

  try {
    await setZonePower(zone, on);
    res.json({ ok: true, zone, power: on });
  } catch (err) {
    console.error('POST power error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zone/:zone/source  body: { source: 1-6 }
app.post('/api/zone/:zone/source', async (req, res) => {
  const zone   = parseInt(req.params.zone, 10);
  const source = parseInt(req.body.source, 10);
  if (!validZone(zone))   return res.status(400).json({ error: 'zone must be 1-6' });
  if (!validSource(source)) return res.status(400).json({ error: 'source must be 1-6' });

  try {
    await setZoneSource(zone, source);
    res.json({ ok: true, zone, source });
  } catch (err) {
    console.error('POST source error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zone/:zone/volume  body: { volume: 0-38 }
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
    console.error('POST volume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serial open + server start ───────────────────────────────────────────────
serial.open((err) => {
  if (err) {
    console.error(`Failed to open serial port ${SERIAL_PATH}:`, err.message);
    console.error('Set SERIAL_PATH env var to the correct device (e.g. /dev/ttyUSB0)');
    process.exit(1);
  }
  console.log(`Serial port ${SERIAL_PATH} open at ${BAUD_RATE} baud`);

  app.listen(PORT, () => {
    console.log(`Monoprice controller listening on http://0.0.0.0:${PORT}`);
  });
});

serial.on('error', (err) => {
  console.error('Serial error:', err.message);
});
