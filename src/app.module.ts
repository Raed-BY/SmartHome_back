import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { AppController } from './app.controller';
import { User, UserSchema } from './user.schema';
import { Sensor, SensorSchema } from './sensor.schema';
import { RfidCard, RfidCardSchema } from './rfid-card.schema';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forRoot(process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/smarthome'),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Sensor.name, schema: SensorSchema },
      { name: RfidCard.name, schema: RfidCardSchema },
    ]),
  ],
  controllers: [AppController],
})
export class AppModule {}
