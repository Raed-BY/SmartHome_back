import {
  Controller,
  Get,
  Post,
  Body,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';

@Controller('smarthome')
export class AppController {
  private currentUserName = 'Guest';

  private currentLights = {
    'Living Room': false,
    Bedroom: false,
    Kitchen: false,
    Garage: false,
  };

  private manualPumpState = false;

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Sensor.name) private sensorModel: Model<Sensor>,
  ) {}

  @Post('login')
  async login(@Body() body: any) {
    const user = await this.userModel.findOne({
      email: body.email,
      pass: body.pass,
    });
    if (user) {
      this.currentUserName = user.name;
      return { success: true, name: user.name };
    }
    throw new UnauthorizedException('Invalid credentials');
  }

  @Post('signup')
  async signup(@Body() body: any) {
    try {
      const newUser = new this.userModel(body);
      await newUser.save();
      return { success: true };
    } catch (error) {
      if (error.code === 11000) {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  @Get('status')
  async getStatus() {
    const latestData = await this.sensorModel.findOne().sort({ timestamp: -1 });
    return {
      tempSalon: latestData?.tempSalon ?? 0,
      soilMoisture: latestData?.soilMoisture ?? 0,
      gasLevel: latestData?.gasLevel ?? 0,
      isRaining: latestData?.isRaining ?? false,
      motionDetected: latestData?.motionDetected ?? false,
      manualPump: this.manualPumpState,
      lights: this.currentLights,
      systemInfo: {
        userName: this.currentUserName,
        version: '1.2.0',
        deviceModel: 'ESP32-S3',
        wifiStatus: 'Connected',
        serverIP: '192.168.1.7',
      },
    };
  }

  @Post('update')
  async updateStatus(@Body() newData: any) {
    const dataToSave = { ...newData, manualPump: this.manualPumpState };
    const dataEntry = new this.sensorModel(dataToSave);
    await dataEntry.save();
    return { success: true };
  }

  @Post('toggle-pump')
  async togglePump(@Body() body: { state: boolean }) {
    this.manualPumpState = body.state;
    return { success: true };
  }

  @Post('toggle-light')
  async toggleLight(@Body() body: { name: string; state: boolean }) {
    if (this.currentLights.hasOwnProperty(body.name)) {
      this.currentLights[body.name] = body.state;
      return { success: true };
    }
    return { success: false };
  }
}
