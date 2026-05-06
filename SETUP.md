# Raspberry Pi Setup Guide

## 1. Install Node.js (v20 LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x.x
```

## 2. Clone / copy project files

Place all three files in one directory, e.g. `/opt/monoprice-amp/`:

```
/opt/monoprice-amp/
  package.json
  server.js
  public/
    index.html
```

## 3. Install dependencies

```bash
cd /opt/monoprice-amp
npm install
```

## 4. Find your serial device

Plug in the USB-to-RS232 adapter, then:

```bash
ls /dev/ttyUSB*   # FTDI / generic: /dev/ttyUSB0
ls /dev/ttyACM*   # Some adapters enumerate here
```

## 5. Add your user to the `dialout` group

```bash
sudo usermod -aG dialout $USER
# Log out and back in for this to take effect
```

## 6. Test manually

```bash
SERIAL_PATH=/dev/ttyUSB0 PORT=3000 npm start
# Then open http://<pi-ip>:3000 in your browser
```

## 7. Create a systemd service for auto-start

Create `/etc/systemd/system/monoprice-amp.service`:

```ini
[Unit]
Description=Monoprice 10761 Web Controller
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/monoprice-amp
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=SERIAL_PATH=/dev/ttyUSB0
ExecStart=/usr/bin/node /opt/monoprice-amp/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable monoprice-amp
sudo systemctl start  monoprice-amp
sudo systemctl status monoprice-amp   # verify it's running
```

View logs:

```bash
journalctl -u monoprice-amp -f
```

## 8. Access the UI

Open `http://<raspberry-pi-ip>:3000` on any phone or browser on your network.
