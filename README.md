# Monoprice 6‑Zone Audio Web UI

A mobile‑friendly web interface for the Monoprice 6‑zone whole‑home audio amplifier (model 10761), running on a Raspberry Pi with a USB‑to‑serial adapter. The app lets you control each zone’s power, source, and volume, with:

- Per‑zone names and icons (Kitchen, Patio, etc.).
- Shared, editable source names.
- Light/dark theme toggle.
- Live state polling from the amp.
- All UI configuration persisted in the browser via `localStorage`.[^1][^2]

The Monoprice 6‑zone amp supports RS‑232 control at 9600 8‑N‑1, which is well suited to a Raspberry Pi plus USB‑to‑serial adapter.[^3][^4]

***

## 1. Requirements

- Raspberry Pi running Raspberry Pi OS or similar.
- Monoprice 6‑zone whole‑home audio amplifier (model 10761).
- USB‑to‑serial adapter (RS‑232 to USB) connected between Pi and amp.
- Node.js (with npm) installed on the Pi.[^5][^6]

***

## 2. Installation

### 2.1. Clone or copy the project

On the Pi:

```bash
mkdir -p /data/monoprice-audio-web
cd /data/monoprice-audio-web
# Copy server.js, package.json, public/index.html into this directory
```

Ensure the directory owner matches the user you’ll run the service as (e.g., `admin`):

```bash
sudo chown -R admin:admin /data/monoprice-audio-web
```


### 2.2. Install Node.js and npm

If `npm` is missing, installing from NodeSource is usually the most reliable on Raspberry Pi OS.[^6][^7][^8]

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

You should see valid versions for both `node` and `npm`. If `npm` is still not found, check PATH and that `nodejs` installed correctly.[^8][^9]

### 2.3. Install app dependencies

From the project directory:

```bash
cd /data/monoprice-audio-web
npm install
```

This installs `express`, `cors`, and `serialport`, which provide the web server and serial communication components.[^10]

### 2.4. USB serial permissions

On Raspberry Pi OS, USB‑serial devices typically show up as `/dev/ttyUSB0` or `/dev/ttyACM0` and require membership in the `dialout` group.[^11][^12]

```bash
ls /dev/ttyUSB*
sudo usermod -aG dialout admin
sudo reboot
```

After reboot, confirm you can access the device as your user.

***

## 3. Running the app manually

From `/data/monoprice-audio-web`:

```bash
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start
```

Then from another machine on the LAN, visit:

```text
http://<pi-ip-address>:3000
```

You should see the 6‑zone dashboard.

***

## 4. systemd service

To run the app as a service on boot, create:

`/etc/systemd/system/monoprice-audio.service`:

```ini
[Unit]
Description=Monoprice Audio Web UI
After=network.target

[Service]
Type=simple
User=admin
Group=admin
WorkingDirectory=/data/monoprice-audio-web
Environment=PORT=3000
Environment=SERIAL_PATH=/dev/ttyUSB0
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> Important: `User=` and `Group=` must match an actual local user (e.g., `admin`). Setting a non‑existent or wrong user is a common cause of `status=217/USER` failures.[^13][^14][^15]

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable monoprice-audio
sudo systemctl start monoprice-audio
sudo systemctl status monoprice-audio
```

Now the app will start on boot and listen on `PORT` (default 3000).

***

## 5. Web UI features

### 5.1. Zones

- 6 cards, one per zone.
- Each card shows:
    - Icon (emoji).
    - Zone name (e.g., Kitchen, Patio).
    - Single power toggle button.
    - Source select dropdown.
    - Volume slider and status text.


### 5.2. Zone names and icons

- Click the ✏️ icon on a zone card to rename the zone and change its icon key.
- Icon keys map to emojis (e.g., `kitchen`, `patio`, `living`, `garage`).
- The UI stores zone names and icons in a `settings` object in `localStorage`, which persists between sessions for the same origin.[^2][^1]


### 5.3. Source names (shared across zones)

- Click **Edit Sources** in the header.
- A modal opens with text fields for Source 1–6.
- Updating these names changes how each source appears in all zone dropdowns and status messages.
- Source names are stored once in `settings.sourceNames` and reused across every zone.[^16][^17]


### 5.4. Theme (light/dark)

- Click the theme button (🌞 / 🌙) to toggle light or dark mode.
- Theme choice is stored in `settings.theme` and applied on every load.[^1]

***

## 6. Configuration persistence

The web UI keeps user preferences in the browser using `localStorage`, which provides persistent, client‑side key/value storage scoped to the app’s origin.[^2][^1]

### 6.1. What is persisted

All of these go into one JSON object under `monoprice_ui_settings_v1`:

- `theme` – `"light"` or `"dark"`.
- `sourceNames` – map of `1..6` → label.
- `zones` – per‑zone `name` and `icon` (for zones 1–6).

On every UI change (rename zone, change icon, edit sources, toggle theme), the app updates the in‑memory `settings` object and calls `localStorage.setItem(...)` to save it.[^18][^19]

### 6.2. Reload behavior

- On page load, the app:
    - Reads `monoprice_ui_settings_v1`.
    - Merges it with a default configuration.
    - Applies theme.
    - Renders zones using saved names/icons/source labels.
- On a refresh or browser restart, the configuration is restored from `localStorage`. Data is retained until cleared manually or the browser storage is wiped.[^20][^1]


### 6.3. Multiple tabs

The app listens to the `storage` event to sync settings if you have multiple tabs open:

- When settings change in one tab, other tabs receive a `storage` event and reload the configuration and UI.[^21][^22]

***

## 7. Amplifier communication

The Monoprice 10761 uses an RS‑232 protocol for zone control. Community examples and documentation indicate commands like `!11P1` to turn on zone 1 and `?11P` to query its power state, with CR line endings and 9600 baud.[^4][^23][^3]

This service:

- Sends commands like:
    - `!ZZP1` / `!ZZP0` for power on/off for zone `Z`.
    - `!ZZSx` for source `x`.
    - `!ZZVnn` for volume.
- Polls state using `/api/state?zone=Z`, which:
    - Issues RS‑232 queries for power, source, and volume.
    - Parses numeric values out of the responses.
    - Returns JSON like:

```json
{
  "zone": 1,
  "power": true,
  "source": 2,
  "volume": 35
}
```


> Note: You may need to adjust the exact command strings to match the protocol table in your Monoprice manual if your firmware variant differs.[^3][^4]

***

## 8. Troubleshooting

### 8.1. `npm: command not found`

If `npm` is missing:

```bash
node -v
npm -v
```

If `npm` is not installed or is too old, install from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Raspberry Pi users often report that `nodejs` from the default repo may not include a modern `npm`, so using NodeSource is a common fix.[^7][^6][^8]

### 8.2. Service status shows `status=217/USER`

Run:

```bash
sudo systemctl status monoprice-audio
```

If you see `code=exited, status=217/USER`, it means systemd can’t run the process as the configured user:

- Confirm your service file has the correct user:

```bash
sudo systemctl cat monoprice-audio
```

- If the file says `User=pi` but your login is `admin`, change it to:

```ini
User=admin
Group=admin
```

- Reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart monoprice-audio
```


Systemd docs and community answers confirm that `217/USER` is specifically tied to an invalid or missing User in the unit.[^14][^15][^13]

### 8.3. Service fails for another reason

Check logs:

```bash
journalctl -u monoprice-audio -xe --no-pager
```

Look for:

- Wrong `WorkingDirectory`.
- Wrong `ExecStart` path (e.g., `/usr/bin/npm` vs `/usr/local/bin/npm`).
- Serial permission errors: `EACCES` or `Permission denied` on `/dev/ttyUSB0`.

If serial permission errors appear, ensure your service user is in `dialout` and the service has restarted after you changed group membership.[^12][^11]

### 8.4. Web UI loads but state is “Offline”

- Confirm the Pi can reach the amp:
    - Check serial cable and RS‑232 port on the amp.
    - Verify amp’s baud and settings match `9600 8‑N‑1` in the manual.[^3]
- Temporarily run the app in the foreground:

```bash
cd /data/monoprice-audio-web
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start
```

and watch for serial errors in the terminal.

***

## 9. Customization

- Adjust default zone presets in `index.html` (names and icons).
- Change polling interval (currently 30 seconds) if you want more/less frequent state updates.
- Host behind an Nginx reverse proxy or TLS terminator if you want HTTPS; the app itself is plain HTTP on the configured port.

***

If you want to extend this further (e.g., add an “All Off” button or per‑source volume presets), you can reuse the same API endpoints and `localStorage` configuration model described above.[^1][^2]

<div align="center">⁂</div>

[^1]: https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage

[^2]: https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Client-side_APIs/Client-side_storage

[^3]: https://downloads.monoprice.com/files/manuals/10761_Manual_141028.pdf

[^4]: https://mcurcio.com/2020/06/monoprice-31028-rs232/

[^5]: https://nodered.org/docs/getting-started/raspberrypi

[^6]: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/

[^7]: https://forums.raspberrypi.com/viewtopic.php?t=141770

[^8]: https://www.reddit.com/r/raspberry_pi/comments/w1igk6/i_installed_nodejs_but_npm_is_missing/

[^9]: https://stackoverflow.com/questions/31472755/sudo-npm-command-not-found

[^10]: https://serialport.io/docs/guide-installation/

[^11]: https://roboticsbackend.com/raspberry-pi-hardware-permissions/

[^12]: https://support.mosaicmfg.com/Guide/Enabling+USB-Serial+Port+Permissions+on+Linux/94

[^13]: https://stackoverflow.com/questions/48176240/how-to-debug-a-failed-systemctl-service-code-exited-status-217-user

[^14]: https://www.reddit.com/r/linuxquestions/comments/oaya49/systemd_service_not_starting_with_status217/

[^15]: https://forum.manjaro.org/t/systemd-unit-not-starting/129377

[^16]: https://homeassistant.jongriffith.com/2022/05/24/how-to-setup-the-monoprice-6-zone-amplifier-to-work-with-home-assistant/

[^17]: https://github.com/zegelin/mwha2mqtt

[^18]: https://blog.logrocket.com/localstorage-javascript-complete-guide/

[^19]: https://blog.devgenius.io/local-storage-persistent-client-side-data-storage-c6558fab2f9d

[^20]: https://stackoverflow.com/questions/9948284/how-persistent-is-localstorage

[^21]: https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event

[^22]: https://nabeelvalley.co.za/blog/2024/07-03/localstorage-based-sync/

[^23]: https://www.openhab.org/addons/bindings/monopriceaudio/