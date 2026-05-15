import {
  BadRequestException,
  Body,
  Controller,
  Get,
  OnModuleInit,
  Post,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectModel } from '@nestjs/mongoose';
import {
  Client,
  ClientProxy,
  MessagePattern,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import {
  decryptDoorbellPayload,
  getEncryptionKeyFromEnv,
} from './doorbell.crypto';
import { RfidCard } from './rfid-card.schema';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';
import * as jwtModule from 'jsonwebtoken';
import { Request } from 'express';

interface JwtApi {
  sign(
    payload: string | object | Buffer,
    secretOrPrivateKey: string,
    options?: { expiresIn?: string | number },
  ): string;
  verify(
    token: string,
    secretOrPublicKey: string,
  ): { email?: string; name?: string } | string;
}

const jwt = jwtModule as unknown as JwtApi;

interface SensorUpdateDto {
  tempSalon?: number;
  soilMoisture?: number;
  gasLevel?: number;
  smokeLevel?: number;
  isRaining?: boolean;
  motionDetected?: boolean;
  motion?: boolean;
}

@Controller('smarthome')
export class AppController implements OnModuleInit {
  @Client({
    transport: Transport.MQTT,
    options: { url: process.env.MQTT_URL ?? 'mqtt://172.20.10.4:1883' },
  })
  mqttClient!: ClientProxy;

  private currentUserName = 'test';
  private pumpState = false;
  // When true, pumpState was set manually by the user and should not be overridden by automation
  private manualPumpOverride = false;
  private pumpEvalInterval: NodeJS.Timeout | null = null;
  private weatherReason = 'System Monitoring';
  private garageOpen = false;
  private motionDetected = false;
  private motionClearTimer: NodeJS.Timeout | null = null;
  private lastVisitor = 'No one at the door';

  private currentLights: Record<string, boolean> = {
    'Living Room': false,
    Bedroom: false,
    Kitchen: false,
    Garage: false,
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Sensor.name) private sensorModel: Model<Sensor>,
    @InjectModel(RfidCard.name) private rfidCardModel: Model<RfidCard>,
    private readonly httpService: HttpService,
  ) {}

  onModuleInit() {
    this.publishSensorData({
      tempSalon: 0,
      soilMoisture: 0,
      gasLevel: 0,
      isRaining: false,
      motionDetected: false,
    });
    this.publishDeviceState();
    // Run periodic pump evaluation every 5 minutes
    this.pumpEvalInterval = setInterval(() => {
      this.evaluatePump().catch((e) => console.error('Pump evaluation failed:', e));
    }, 5 * 60 * 1000);
  }

  // Evaluate pump state using latest sensor data and weather when in automatic mode
  private async evaluatePump() {
    if (this.manualPumpOverride) return; // do not override manual control

    try {
      const latest = await this.sensorModel.findOne().sort({ timestamp: -1 }).exec();
      const soil = latest?.soilMoisture;
      
      if (typeof soil === 'number' && soil < 30) {
        let isRaining = typeof latest?.isRaining === 'boolean' ? latest.isRaining : false;

        if (typeof latest?.isRaining !== 'boolean') {
          try {
            const owmKey = '2c688507ce53db36534c86d0a2a690f5';
            const weatherCity = process.env.WEATHER_CITY ?? 'Sousse';
            const response = await firstValueFrom(
              this.httpService.get<{ weather?: Array<{ main?: string }> }>(
                `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(weatherCity)}&appid=${owmKey}`,
              ),
            );
            isRaining = response.data.weather?.[0]?.main === 'Rain';
          } catch (_e) {
            // Safe fallback: if weather provider fails and soil is dry, water.
            isRaining = false;
            this.weatherReason = 'Weather API failed. Dry fallback.';
          }
        }

        if (isRaining) {
          this.pumpState = false;
          this.weatherReason = 'Rain in Tunis. Skip.';
        } else {
          this.pumpState = true;
          this.weatherReason = 'Dry Tunis. Watering.';
        }
        this.publishDeviceState();
      } else if (typeof soil === 'number' && soil >= 30) {
        this.pumpState = false;
        this.weatherReason = 'Soil Healthy';
        this.publishDeviceState();
      }
    } catch (err) {
      console.error('evaluatePump error:', err);
    }
  }

  @MessagePattern('home/doorbell')
  handleDoorbell(@Payload() data: string) {
    try {
      const key = getEncryptionKeyFromEnv();
      if (!key) {
        console.error('DOORBELL_ENCRYPTION_KEY is missing or invalid');
        return;
      }

      const decrypted = decryptDoorbellPayload(data, key);
      this.lastVisitor = `${decrypted.person} is at the door`;
      this.motionDetected = true;
    } catch (error) {
      console.error('Decryption failed:', error);
    }
  }

  @Post('update')
  async updateStatus(@Body() newData: SensorUpdateDto) {
    let pump = this.pumpState;
    const gasLevel = newData.gasLevel ?? newData.smokeLevel;
    const motionDetected = newData.motionDetected ?? newData.motion ?? false;
    this.motionDetected = motionDetected;

    // If motion detected, schedule a clear after 60 seconds (reset to safe)
    if (motionDetected) {
      if (this.motionClearTimer) {
        clearTimeout(this.motionClearTimer);
      }
      this.motionClearTimer = setTimeout(() => {
        this.motionClearTimer = null;
        this.motionDetected = false;
        try {
          this.mqttClient
            .emit('home/sensors/motion', '0')
            .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
        } catch (e) {
          console.error('Error publishing motion clear to MQTT:', e);
        }
      }, 60 * 1000);
    } else {
      if (this.motionClearTimer) {
        clearTimeout(this.motionClearTimer);
        this.motionClearTimer = null;
      }
    }

    if (
      !this.manualPumpOverride &&
      typeof newData.soilMoisture === 'number' &&
      newData.soilMoisture < 30
    ) {
      let isRaining = typeof newData.isRaining === 'boolean' ? newData.isRaining : false;

      if (typeof newData.isRaining !== 'boolean') {
        try {
          const owmKey = '2c688507ce53db36534c86d0a2a690f5';
          const weatherCity = process.env.WEATHER_CITY ?? 'Sousse';
          const response = await firstValueFrom(
            this.httpService.get<{ weather?: Array<{ main?: string }> }>(
              `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(weatherCity)}&appid=${owmKey}`,
            ),
          );
          isRaining = response.data.weather?.[0]?.main === 'Rain';
        } catch (_e) {
          // Safe fallback: if weather lookup fails while soil is dry, keep watering enabled.
          isRaining = false;
          this.weatherReason = 'Weather API failed. Dry fallback.';
        }
      }

      if (isRaining) {
        pump = false;
        this.weatherReason = 'Rain in Tunis. Skip.';
      } else {
        pump = true;
        this.weatherReason = 'Dry Tunis. Watering.';
      }
    } else {
      this.weatherReason =
        typeof newData.soilMoisture === 'number' && newData.soilMoisture >= 30
          ? 'Soil Healthy'
          : this.manualPumpOverride
          ? 'Manual Mode'
          : 'No Action';
    }

    // store resulting pump state (but don't change manual override flag)
    // store resulting pump state (but only if not in manual override mode)
    if (!this.manualPumpOverride) {
      this.pumpState = pump;
    }

    await new this.sensorModel({
      ...newData,
      gasLevel,
      motionDetected,
      // `manualPump` field indicates whether the pump is under manual override (not the current pump state)
      manualPump: this.manualPumpOverride,
      garageOpen: this.garageOpen,
      roomLights: this.currentLights,
      timestamp: new Date(),
    }).save();

    // Publish sensor data to MQTT
    this.publishSensorData(newData);
    // Publish device state (pump/garage/lights) so devices receive updated pumpState
    this.publishDeviceState();

    return {
      success: true,
      pump,
      weatherReason: this.weatherReason,
      manualPumpOverride: this.manualPumpOverride,
    };
  }

  @Post('rfid/authorize')
  async authorizeRfid(@Body() body: { uid?: string }) {
    const uid = body.uid?.trim().toUpperCase();
    if (!uid) {
      throw new BadRequestException('UID is required');
    }

    const card = await this.rfidCardModel.findOne({ uid, active: true }).exec();

    return {
      authorized: !!card,
      uid,
      ownerName: card?.ownerName ?? '',
      active: !!card,
    };
  }

  @Get('status')
  async getStatus() {
    const latest = await this.sensorModel
      .findOne()
      .sort({ timestamp: -1 })
      .exec();

    const latestGasLevel = latest?.gasLevel ?? 0;
    const latestMotion = latest?.motionDetected ?? this.motionDetected;
    const smokeDanger = latestGasLevel > 3000;

    return {
      tempSalon: latest?.tempSalon ?? 0,
      soilMoisture: latest?.soilMoisture ?? 0,
      gasLevel: latestGasLevel,
      smokeDanger,
      isRaining: latest?.isRaining ?? false,
      motionDetected: latestMotion,
      lastVisitor: this.lastVisitor,
      lights: this.currentLights,
      manualPump: this.manualPumpOverride,
      garageOpen: this.garageOpen,
      pump: this.pumpState,
      weatherReason: this.weatherReason,
      systemInfo: {
        userName: this.currentUserName,
        serverIP: '172.20.10.2',
      },
    };
  }

  @Post('toggle-light')
  toggleLight(@Body() body: { name: string; state: boolean }) {
    this.currentLights[body.name] = body.state;
    const room = body.name.toUpperCase().replace(/ /g, '_');
    const command = `LIGHT_${room}_${body.state ? 'ON' : 'OFF'}`;
    this.publishMqttCommand(command);
    this.publishDeviceState();
    return { success: true };
  }

  @Post('toggle-pump')
  togglePump(@Body() body: { state?: boolean }) {
    const newState = typeof body.state === 'boolean' ? body.state : !this.pumpState;
    
    if (newState === true) {
      // User toggled ON -> enable manual override (pump under user control)
      this.pumpState = true;
      this.manualPumpOverride = true;
      this.weatherReason = 'Manual Mode: Pump ON';
    } else {
      // User toggled OFF -> disable manual override and resume automatic mode
      this.manualPumpOverride = false;
      this.pumpState = false;
      this.weatherReason = 'Automatic Mode: Back to auto-control';
      this.evaluatePump().catch((err) =>
        console.error('Pump evaluation failed:', err),
      );
    }
    
    this.publishDeviceState();
    return {
      success: true,
      manualPump: this.manualPumpOverride,
      pump: this.pumpState,
      weatherReason: this.weatherReason,
    };
  }

  @Post('toggle-garage')
  toggleGarage(@Body() body: { state?: boolean }) {
    this.garageOpen = body.state ?? !this.garageOpen;
    this.publishDeviceState();
    return {
      success: true,
      garageOpen: this.garageOpen,
    };
  }

  @Post('toggle-door')
  openDoor() {
    this.publishMqttCommand('UNLOCK');
    this.publishDeviceState();
    return { success: true };
  }

  @Post('reset-doorbell')
  reset() {
    if (this.motionClearTimer) {
      clearTimeout(this.motionClearTimer);
      this.motionClearTimer = null;
    }
    this.motionDetected = false;
    this.lastVisitor = 'No one at the door';
    // publish cleared motion to MQTT so dashboard updates immediately
    try {
      this.mqttClient
        .emit('home/sensors/motion', '0')
        .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
    } catch (e) {
      console.error('Error publishing motion clear to MQTT:', e);
    }
    return { success: true };
  }

  @Post('change-password')
  changePassword(@Body() body: { newPass?: string }) {
    if (!body.newPass || body.newPass.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }
    return { success: true };
  }

  @Post('login')
  async login(@Body() body: { email?: string; pass?: string }) {
    const email = body.email?.trim();
    const pass = body.pass?.trim();

    if (!email || !pass) {
      throw new BadRequestException('Email and password are required');
    }

    const user = await this.userModel.findOne({ email, pass }).exec();
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    this.currentUserName = user.name;
    const secret = process.env.JWT_SECRET || 'smarthome_secret';
    const token = jwt.sign({ email: user.email, name: user.name }, secret, {
      expiresIn: '7d',
    });
    return {
      success: true,
      name: user.name,
      token,
      biometricEnabled: !!user.biometricEnabled,
    };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Missing Authorization');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new UnauthorizedException('Invalid Authorization');
    }

    const token = parts[1];
    const secret = process.env.JWT_SECRET || 'smarthome_secret';
    try {
      const payload = jwt.verify(token, secret) as {
        email?: string;
        name?: string;
      };
      const user = await this.userModel
        .findOne({ email: payload.email })
        .exec();
      if (!user) throw new UnauthorizedException('User not found');
      return {
        success: true,
        name: user.name,
        email: user.email,
        biometricEnabled: !!user.biometricEnabled,
      };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  @Post('biometric')
  async setBiometric(@Body() body: { email?: string; enabled?: boolean }) {
    const email = body.email?.trim();
    const enabled = !!body.enabled;
    if (!email) throw new BadRequestException('Email required');
    const user = await this.userModel.findOne({ email }).exec();
    if (!user) throw new BadRequestException('User not found');
    user.biometricEnabled = enabled;
    await user.save();
    return { success: true, biometricEnabled: enabled };
  }

  @Post('signup')
  async signup(@Body() body: { name?: string; email?: string; pass?: string }) {
    const name = body.name?.trim();
    const email = body.email?.trim();
    const pass = body.pass?.trim();

    if (!name || !email || !pass) {
      throw new BadRequestException('Name, email, and password are required');
    }

    const existing = await this.userModel.findOne({ email }).exec();
    if (existing) {
      throw new BadRequestException('Email already exists');
    }

    await new this.userModel({ name, email, pass }).save();
    return { success: true };
  }

  private publishMqttCommand(command: string) {
    this.mqttClient.emit('home/commands', command).subscribe({
      error: (error) => console.error('MQTT publish failed:', error),
    });
  }

  private publishSensorData(data: SensorUpdateDto) {
    try {
      if (typeof data.tempSalon === 'number') {
        this.mqttClient
          .emit('home/sensors/temperature', data.tempSalon.toString())
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      }
      if (typeof data.soilMoisture === 'number') {
        this.mqttClient
          .emit('home/sensors/soil_moisture', data.soilMoisture.toString())
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      }
      const gasLevel = data.gasLevel ?? data.smokeLevel;
      if (typeof gasLevel === 'number') {
        this.mqttClient
          .emit('home/sensors/gas_level', gasLevel.toString())
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      }
      const motionDetected = data.motionDetected ?? data.motion ?? false;
      if (typeof motionDetected === 'boolean') {
        this.mqttClient
          .emit('home/sensors/motion', motionDetected ? '1' : '0')
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      }
      if (typeof data.isRaining === 'boolean') {
        this.mqttClient
          .emit('home/sensors/rain', data.isRaining ? '1' : '0')
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      }
    } catch (error) {
      console.error('Error publishing sensor data to MQTT:', error);
    }
  }

  private publishDeviceState() {
    try {
      this.mqttClient
        .emit('home/devices/pump', this.pumpState ? '1' : '0')
        .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      this.mqttClient
        .emit('home/devices/garage', this.garageOpen ? '1' : '0')
        .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      Object.entries(this.currentLights).forEach(([room, state]) => {
        const topic = `home/devices/light_${room.toUpperCase().replace(/ /g, '_')}`;
        this.mqttClient
          .emit(topic, state ? '1' : '0')
          .subscribe({ error: (e) => console.error('MQTT publish error:', e) });
      });
    } catch (error) {
      console.error('Error publishing device state to MQTT:', error);
    }
  }
}
