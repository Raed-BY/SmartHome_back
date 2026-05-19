import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { NextFunction, Request, Response } from 'express';

interface RawBodyRequest extends Request {
  rawBody?: string;
}

const smartHomeHost = process.env.SMART_HOME_HOST ?? '172.20.10.4';
const mqttUrl = process.env.MQTT_URL ?? `mqtt://${smartHomeHost}:1883`;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Bind to all interfaces by default; override with HOST when needed
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);

  // Connect MQTT microservice so @MessagePattern handlers receive Pi/ESP32 messages
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.MQTT,
    options: { url: mqttUrl },
  });
  await app.startAllMicroservices();

  // 1. Enable CORS so your iPhone and Browser can talk to the server
  app.enableCors();

  // 1b. Install body parsers with a verify hook so we can log raw bodies for debugging
  app.use(
    bodyParser.json({
      verify: (req: RawBodyRequest, _res, buf) => {
        try {
          req.rawBody = buf.toString();
        } catch {
          req.rawBody = undefined;
        }
      },
    }),
  );
  app.use(
    bodyParser.urlencoded({
      extended: true,
      verify: (req: RawBodyRequest, _res, buf) => {
        try {
          req.rawBody = buf.toString();
        } catch {
          req.rawBody = undefined;
        }
      },
    }),
  );

  // 1c. Simple request logger to print raw bodies for debugging mobile POSTs
  app.use((req: RawBodyRequest, _res: Response, next: NextFunction) => {
    console.log(
      `[REQ] ${req.method} ${req.url} rawBody=${
        req.rawBody ? req.rawBody : '<empty>'
      }`,
    );
    next();
  });

  // 2. Listen on configured host/IP on port 3000
  await app.listen(port, host);

  console.log('-------------------------------------------');
  console.log('SmartHome Server is RUNNING');
  console.log(`Listening on http://${host}:${port}`);
  console.log(
    'For mobile device testing use your PC LAN IP in the Flutter app baseUrl.',
  );
  console.log('-------------------------------------------');
}

// 3. FIXED: We add .catch() to handle any errors during startup
// This satisfies the ESLint "no-floating-promises" rule
bootstrap().catch((err) => {
  console.error('❌ Error starting the server:', err);
});
