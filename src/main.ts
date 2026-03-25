import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Enable CORS so your iPhone and Browser can talk to the server
  app.enableCors();

  // 2. Listen on all network interfaces (0.0.0.0) on port 3000
  await app.listen(3000, '0.0.0.0');

  console.log('-------------------------------------------');
  console.log('🚀 SmartHome Server is RUNNING');
  console.log('📡 Local URL: http://localhost:3000');
  console.log('📱 Phone URL: http://192.168.1.7:3000');
  console.log('-------------------------------------------');
}

// 3. FIXED: We add .catch() to handle any errors during startup
// This satisfies the ESLint "no-floating-promises" rule
bootstrap().catch((err) => {
  console.error('❌ Error starting the server:', err);
});
