# SmartHome Backend

NestJS backend for the SmartHome project. It exposes the HTTP API used by the mobile app and also connects to MQTT for device and sensor communication.

## What it does

- Authenticates users with login, signup, biometric toggle, and JWT-based session checks.
- Returns live home status for temperature, soil moisture, gas level, motion, doorbell, lights, garage, and pump.
- Handles smart-home actions like light toggle, pump control, garage toggle, and door unlock.
- Publishes and receives MQTT messages for ESP32 / Raspberry Pi device integration.
- Sends emergency email alerts when smoke or gas thresholds are exceeded.

## Main API routes

- `POST /smarthome/login`
- `POST /smarthome/signup`
- `GET /smarthome/me`
- `GET /smarthome/status`
- `POST /smarthome/update`
- `POST /smarthome/toggle-light`
- `POST /smarthome/toggle-pump`
- `POST /smarthome/toggle-pump-system`
- `POST /smarthome/toggle-garage`
- `POST /smarthome/toggle-door`
- `POST /smarthome/reset-doorbell`
- `POST /smarthome/rfid/authorize`
- `POST /smarthome/biometric`
- `POST /smarthome/change-password`

## Requirements

- Node.js 18+ recommended
- MongoDB running locally or a remote `DATABASE_URL`
- MQTT broker available through `MQTT_URL`

## Environment variables

Create a `.env` file if needed:

```bash
DATABASE_URL=mongodb://127.0.0.1:27017/smarthome
MQTT_URL=mqtt://YOUR_MQTT_HOST:1883
JWT_SECRET=your_secret_key
SMTP_USER=your_gmail_address
SMTP_PASS=your_gmail_app_password
ALERT_RECIPIENT=target_email@example.com
HOST=0.0.0.0
PORT=3000
SMART_HOME_HOST=192.168.1.10
OPENWEATHER_KEY=your_openweather_key
WEATHERBIT_KEY=your_weatherbit_key
WEATHER_CITY=Sousse
DOORBELL_ENCRYPTION_KEY=your_key
```

## Install

```bash
npm install
```

## Run

```bash
# development
npm run start:dev

# production
npm run start:prod
```

## Test

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## Demo video

The demo video is stored in the mobile app repository. Watch it here:

[Watch the SmartHome demo](https://github.com/Raed-BY/SmartHome_mobile/blob/main/assets/demo/demo.mp4)

The video is tracked with Git LFS in the mobile repository.
