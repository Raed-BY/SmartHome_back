import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { User, UserSchema } from './user.schema';
import { Sensor, SensorSchema } from './sensor.schema';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/smarthome'),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Sensor.name, schema: SensorSchema },
    ]),
  ],
  controllers: [AppController],
})
export class AppModule {}
