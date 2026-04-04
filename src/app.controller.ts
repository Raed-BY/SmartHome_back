import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request } from 'express';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';

interface SensorUpdateDto {
  tempSalon?: number;
  soilMoisture?: number;
  gasLevel?: number;
  isRaining?: boolean;
  motionDetected?: boolean;
}

@Controller('smarthome')
export class AppController {
  private currentUserName = 'Guest';
  private currentUserEmail = '';
  private manualPumpState = false;
  private manualCanopyState = false;
  private garageOpen = false;
  private proximityEnabled = true;
  private lastManualCloseTime = 0;
  private readonly activeClients = new Map<string, number>();
  private readonly activeWindowMs = 15_000;

  private currentLights: Record<string, boolean> = {
    'Living Room': false,
    Bedroom: false,
    Kitchen: false,
    Garage: false,
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Sensor.name) private sensorModel: Model<Sensor>,
  ) {}

  private updateActiveClients(key: string) {
    const now = Date.now();
    this.activeClients.set(key, now);

    for (const [clientKey, lastSeen] of this.activeClients.entries()) {
      if (now - lastSeen > this.activeWindowMs) {
        this.activeClients.delete(clientKey);
      }
    }

    return this.activeClients.size;
  }

  @Post('login')
  async login(@Body() body: { email: string; pass: string }) {
    const user = await this.userModel.findOne({
      email: body.email,
      pass: body.pass,
    });

    if (user) {
      this.currentUserName = user.name;
      this.currentUserEmail = user.email;
      return { success: true, name: user.name };
    }
    throw new UnauthorizedException('Invalid credentials');
  }

  @Post('signup')
  async signup(@Body() body: { name: string; email: string; pass: string }) {
    if (!body.email.includes('@') || !body.email.endsWith('.com')) {
      throw new BadRequestException('Invalid email format');
    }
    if (body.pass.length < 6) {
      throw new BadRequestException('Password too short');
    }

    try {
      const newUser = new this.userModel(body);
      await newUser.save();
      return { success: true };
    } catch (error: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error.code === 11000) {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  @Post('change-password')
  async changePassword(@Body() body: { newPass: string }) {
    if (body.newPass.length < 6) {
      throw new BadRequestException('New password too short');
    }
    await this.userModel.updateOne(
      { email: this.currentUserEmail },
      { pass: body.newPass },
    );
    return { success: true };
  }

  @Get('status')
  async getStatus(@Req() req: Request) {
    const latestData = await this.sensorModel.findOne().sort({ timestamp: -1 });
    const userCount = await this.userModel.countDocuments();
    const clientIdHeader = req.headers['x-client-id'];
    const clientId: string =
      typeof clientIdHeader === 'string' && clientIdHeader.trim().length > 0
        ? clientIdHeader.trim()
        : (req.ip ?? 'unknown-client');
    const activeMembers = this.updateActiveClients(clientId);

    return {
      tempSalon: latestData?.tempSalon ?? 0,
      soilMoisture: latestData?.soilMoisture ?? 0,
      gasLevel: latestData?.gasLevel ?? 0,
      isRaining: latestData?.isRaining ?? false,
      motionDetected: latestData?.motionDetected ?? false,
      manualPump: this.manualPumpState,
      manualCanopy: this.manualCanopyState,
      lights: this.currentLights,
      garageOpen: this.garageOpen,
      proximityEnabled: this.proximityEnabled,
      lastManualCloseTime: this.lastManualCloseTime,
      systemInfo: {
        userName: this.currentUserName,
        activeMembers,
        familyMembers: userCount,
        version: '2.1.5',
        deviceModel: 'ESP32-S3',
        wifiStatus: 'Connected',
        serverIP: '192.168.1.7',
      },
    };
  }

  @Post('update')
  async updateStatus(@Body() newData: SensorUpdateDto) {
    const dataToSave = {
      ...newData,
      manualPump: this.manualPumpState,
    };
    const dataEntry = new this.sensorModel(dataToSave);
    await dataEntry.save();
    return { success: true };
  }

  @Post('toggle-pump')
  togglePump(@Body() body: { state: boolean }) {
    this.manualPumpState = body.state;
    return { success: true };
  }

  @Post('toggle-canopy')
  toggleCanopy(@Body() body: { state: boolean }) {
    this.manualCanopyState = body.state;
    return { success: true };
  }

  @Post('toggle-garage')
  toggleGarage(@Body() body: { state: boolean }) {
    this.garageOpen = body.state;
    if (body.state === false) {
      this.lastManualCloseTime = Date.now();
    }
    return { success: true };
  }

  @Post('toggle-light')
  toggleLight(@Body() body: { name: string; state: boolean }) {
    if (body.name in this.currentLights) {
      this.currentLights[body.name] = body.state;
      return { success: true };
    }
    return { success: false };
  }

  @Post('toggle-proximity')
  toggleProximity(@Body() body: { state: boolean }) {
    this.proximityEnabled = body.state;
    return { success: true };
  }

  @Post('update-garage-status')
  updateGarage(@Body() body: { open: boolean }) {
    this.garageOpen = body.open;
    return { success: true };
  }
}
