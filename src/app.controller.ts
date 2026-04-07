import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request } from 'express';
import { networkInterfaces } from 'os';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  Client,
  ClientProxy,
  MessagePattern,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';
import {
  decryptDoorbellPayload,
  getEncryptionKeyFromEnv,
} from './doorbell.crypto';

interface SensorUpdateDto {
  tempLivingRoom?: number;
  tempSalon?: number;
  soilMoisture?: number;
  gasLevel?: number;
  isRaining?: boolean;
  motionDetected?: boolean;
}

interface WeatherBitForecastResponse {
  data: Array<{ pop: number }>;
}

interface OpenWeatherResponse {
  weather: Array<{ main: string }>;
}

@Controller('smarthome')
export class AppController {
  @Client({
    transport: Transport.MQTT,
    options: { url: 'mqtt://localhost:1883' },
  })
  mqttClient!: ClientProxy;

  private currentUserName = 'Guest';
  private currentUserEmail = '';
  private manualPumpState = false;
  private weatherReason = 'System Monitoring';
  private manualCanopyState = false;
  private garageOpen = false;
  private proximityEnabled = true;
  private lastManualCloseTime = 0;
  private motionDetected = false;
  private lastVisitor = 'No one at the door';
  private readonly activeClients = new Map<string, number>();
  private readonly activeWindowMs = 15_000;
  private readonly validRoomNames = new Set([
    'Living Room',
    'Bedroom',
    'Kitchen',
    'Garage',
  ]);

  private currentLights: Record<string, boolean> = {
    'Living Room': false,
    Bedroom: false,
    Kitchen: false,
    Garage: false,
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Sensor.name) private sensorModel: Model<Sensor>,
    private readonly httpService: HttpService,
  ) {}

  // --- 🌍 MERGED UPDATE STATUS WITH TUNIS WEATHER LOGIC ---
  @Post('update')
  async updateStatus(@Body() newData: SensorUpdateDto) {
    let pumpDecision = this.manualPumpState;
    const soil = newData.soilMoisture ?? 100;
    const tempLivingRoom = newData.tempLivingRoom ?? newData.tempSalon ?? 0;
    this.motionDetected = newData.motionDetected ?? this.motionDetected;

    // 1. If user forced the pump ON from the App
    if (this.manualPumpState) {
      this.weatherReason = 'Manual Overdrive';
      pumpDecision = true;
    }
    // 2. If Pump is AUTO (OFF in app) but Soil is DRY (< 30%)
    else if (soil < 30) {
      console.log('Soil Dry in Tunis. Checking APIs...');

      const WBIT_KEY = 'e08bf140fe684f639bbbf85acd8f2ea6';
      const OWM_KEY = '2c688507ce53db36534c86d0a2a690f5';
      const city = 'Tunis';

      try {
        const [resBit, resOpen] = await Promise.all([
          firstValueFrom(
            this.httpService.get<WeatherBitForecastResponse>(
              `https://api.weatherbit.io/v2.0/forecast/daily?city=${city}&key=${WBIT_KEY}`,
            ),
          ),
          firstValueFrom(
            this.httpService.get<OpenWeatherResponse>(
              `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${OWM_KEY}`,
            ),
          ),
        ]);

        const rainProb = resBit.data.data[0]?.pop ?? 0;
        const isRainingNow = resOpen.data.weather[0].main === 'Rain';

        if (rainProb > 50 || isRainingNow) {
          pumpDecision = false;
          this.weatherReason = isRainingNow
            ? 'Raining now in Tunis'
            : `Rain expected (${rainProb}%)`;
        } else {
          pumpDecision = true;
          this.weatherReason = 'Dry & Sunny. Watering.';
        }
      } catch {
        this.weatherReason = 'Weather API Offline';
        pumpDecision = true; // Safety: water anyway if API fails and soil is dry
      }
    }
    // 3. Soil is healthy
    else {
      this.weatherReason = 'Soil is healthy';
      pumpDecision = false;
    }

    // Save history to MongoDB
    const dataEntry = new this.sensorModel({
      ...newData,
      tempLivingRoom,
      tempSalon: tempLivingRoom,
      manualPump: pumpDecision, // Record the actual pump state
      manualCanopy: this.manualCanopyState,
      garageOpen: this.garageOpen,
      proximityEnabled: this.proximityEnabled,
      roomLights: this.currentLights,
    });
    await dataEntry.save();

    // Return the pump command to the ESP32 (Code you put in ESP32 syncSystem)
    return {
      success: true,
      commandPump: pumpDecision,
    };
  }

  @Get('status')
  async getStatus(@Req() req: Request) {
    const latestData = await this.sensorModel.findOne().sort({ timestamp: -1 });
    const userCount = await this.userModel.countDocuments();
    const clientId: string =
      (req.headers['x-client-id'] as string) ?? req.ip ?? 'unknown';
    const activeMembers = this.updateActiveClients(clientId);

    return {
      tempLivingRoom: latestData?.tempLivingRoom ?? latestData?.tempSalon ?? 0,
      tempSalon: latestData?.tempLivingRoom ?? latestData?.tempSalon ?? 0,
      soilMoisture: latestData?.soilMoisture ?? 0,
      gasLevel: latestData?.gasLevel ?? 0,
      isRaining: latestData?.isRaining ?? false,
      motionDetected: this.motionDetected,
      lastVisitor: this.lastVisitor,
      manualPump: this.manualPumpState,
      weatherReason: this.weatherReason, // This shows "Rain expected" etc in Flutter
      manualCanopy: this.manualCanopyState,
      lights: latestData?.roomLights ?? this.currentLights,
      garageOpen: this.garageOpen,
      proximityEnabled: this.proximityEnabled,
      systemInfo: {
        userName: this.currentUserName,
        activeMembers,
        familyMembers: userCount,
        serverIP: this.getServerLanIp(),
      },
    };
  }

  // --- MQTT DOORBELL (From Raspberry Pi) ---
  @MessagePattern('home/doorbell')
  handleDoorbell(@Payload() data: string | { person?: string }) {
    let person = 'unknown';
    try {
      if (typeof data === 'string') {
        const key = getEncryptionKeyFromEnv();
        if (key) {
          const decrypted = decryptDoorbellPayload(data, key);
          const rawPerson: unknown = decrypted.person;
          person =
            typeof rawPerson === 'string' ? rawPerson.toLowerCase() : 'unknown';
        }
      } else {
        const rawPerson = data.person;
        person =
          typeof rawPerson === 'string' ? rawPerson.toLowerCase() : 'unknown';
      }
    } catch (e) {
      console.error(e);
    }

    this.motionDetected = true;
    this.lastVisitor =
      person === 'raed'
        ? 'Raed is at the door'
        : person === 'safa'
          ? 'Safa is at the door'
          : 'Unknown person at the door';
  }

  // --- CONTROLS ---
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
    throw new UnauthorizedException();
  }

  @Post('toggle-pump')
  togglePump(@Body() body: { state: boolean }) {
    this.manualPumpState = body.state;
    this.publishMqttCommand(body.state ? 'PUMP_ON' : 'PUMP_OFF');
    return { success: true };
  }

  @Post('toggle-light')
  toggleLight(@Body() body: { name: string; state: boolean }) {
    if (!this.validRoomNames.has(body.name)) {
      throw new BadRequestException('Unknown room name');
    }

    this.currentLights[body.name] = body.state;
    const commandName = body.name.toUpperCase().replace(/ /g, '_');
    this.publishMqttCommand(
      `LIGHT_${commandName}_${body.state ? 'ON' : 'OFF'}`,
    );
    return { success: true, lights: this.currentLights };
  }

  @Post('toggle-garage')
  toggleGarage(@Body() body: { state: boolean }) {
    this.garageOpen = body.state;
    this.publishMqttCommand(body.state ? 'GARAGE_OPEN' : 'GARAGE_CLOSE');
    return { success: true, garageOpen: this.garageOpen };
  }

  @Post('toggle-canopy')
  toggleCanopy(@Body() body: { state: boolean }) {
    this.manualCanopyState = body.state;
    this.publishMqttCommand(body.state ? 'CANOPY_OPEN' : 'CANOPY_CLOSE');
    return { success: true, manualCanopy: this.manualCanopyState };
  }

  @Post('toggle-proximity')
  toggleProximity(@Body() body: { state: boolean }) {
    this.proximityEnabled = body.state;
    return { success: true, proximityEnabled: this.proximityEnabled };
  }

  @Post('change-password')
  async changePassword(@Body() body: { newPass: string }) {
    const nextPass = body.newPass?.trim();
    if (!nextPass || nextPass.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }

    if (!this.currentUserEmail) {
      throw new UnauthorizedException('Please login first');
    }

    await this.userModel.updateOne(
      { email: this.currentUserEmail },
      { $set: { pass: nextPass } },
    );
    return { success: true };
  }

  @Post('reset-doorbell')
  reset() {
    this.motionDetected = false;
    this.lastVisitor = 'No one at the door';
    return { success: true };
  }

  private updateActiveClients(key: string) {
    const now = Date.now();
    this.activeClients.set(key, now);
    for (const [k, v] of this.activeClients.entries()) {
      if (now - v > this.activeWindowMs) this.activeClients.delete(k);
    }
    return this.activeClients.size;
  }

  private publishMqttCommand(command: string) {
    this.mqttClient.emit('home/door/control', command).subscribe({
      error: (err) => console.error('MQTT publish failed:', err),
    });
  }

  private getServerLanIp(): string {
    const nets = networkInterfaces();

    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const net of entries) {
        if (net.family !== 'IPv4' || net.internal) continue;
        if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) {
          return net.address;
        }

        const octets = net.address.split('.').map(Number);
        if (octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
          return net.address;
        }
      }
    }

    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const net of entries) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }

    return '127.0.0.1';
  }
}
