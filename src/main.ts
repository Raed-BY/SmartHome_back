import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);

  // 1. Enable CORS so your iPhone and Browser can talk to the server
  app.enableCors();

  // 2. Listen on all network interfaces (0.0.0.0) on port 3000
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
