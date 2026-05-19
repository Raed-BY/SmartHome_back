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
import { Client, ClientProxy, Transport } from '@nestjs/microservices';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import * as mqtt from 'mqtt';
import {
  decryptDoorbellPayload,
  getEncryptionKeyFromEnv,
} from './doorbell.crypto';
import { sendCivilProtectionAlert } from './alert.mailer';
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

  // Raw MQTT client used for device commands — ClientProxy wraps payloads in
  // JSON which the ESP32 cannot parse for simple "1"/"0"/"UNLOCK" strings.
  private rawMqtt!: mqtt.MqttClient;

  private currentUserName = 'test';
  private pumpState = false;
  // When true, pumpState was set manually by the user and should not be overridden by automation
  private manualPumpOverride = false;
  // When true, pump system is entirely disabled — neither manual nor auto can turn it on
  private pumpSystemDisabled = false;
  private pumpEvalInterval: NodeJS.Timeout | null = null;
  private weatherReason = 'System Monitoring';
  private garageOpen = false;
  // Motion state: real-time from MQTT (1 = ALERT, 0 = SAFE)
  private motionDetected = false;
  private lastVisitor = 'No one at the door';
  // Doorbell event flag, INDEPENDENT of PIR motion so ESP32 updates cannot clear it
  private doorbellActive = false;
  private doorbellClearTimer: NodeJS.Timeout | null = null;
  // Monotonically increasing event id; mobile uses this to detect new rings
  // even when the previous event hasn't been dismissed yet.
  private doorbellEventId = 0;

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
      motionDetected: false,
    });
    this.publishDeviceState();
    // Run periodic pump evaluation every 5 minutes
    this.pumpEvalInterval = setInterval(
      () => {
        this.evaluatePump().catch((e) =>
          console.error('Pump evaluation failed:', e),
        );
      },
      5 * 60 * 1000,
    );

    // Raw MQTT client: device commands + doorbell + RFID scan
    this.setupRawMqtt();
  }

  private setupRawMqtt() {
    const url = process.env.MQTT_URL ?? 'mqtt://172.20.10.4:1883';
    this.rawMqtt = mqtt.connect(url);

    this.rawMqtt.on('connect', () => {
      console.log(`[MQTT] raw client connected to ${url}`);
      this.rawMqtt.subscribe('home/doorbell', (err) => {
        if (err) console.error('[MQTT] doorbell subscribe error:', err);
        else console.log('[MQTT] ✓ subscribed to home/doorbell');
      });
      this.rawMqtt.subscribe('home/rfid/scan', (err) => {
        if (err) console.error('[MQTT] rfid/scan subscribe error:', err);
        else console.log('[MQTT] ✓ subscribed to home/rfid/scan');
      });
      this.rawMqtt.subscribe('home/sensors/motion', (err) => {
        if (err) console.error('[MQTT] motion subscribe error:', err);
        else console.log('[MQTT] ✓ subscribed to home/sensors/motion');
      });
      // Push current device state now that the connection is live
      this.publishDeviceState();
    });

    this.rawMqtt.on('error', (err) => {
      console.error('[MQTT] Connection error:', err);
    });

    this.rawMqtt.on('message', (topic, payload) => {
      const msg = payload.toString().trim();
      console.log(`[MQTT] message received: topic=${topic}, payload="${msg}"`);

      if (topic === 'home/doorbell') {
        this.handleDoorbell(msg);
        return;
      }
      if (topic === 'home/rfid/scan') {
        this.handleRfidScan(msg).catch((e) =>
          console.error('[RFID] scan handler error:', e),
        );
        return;
      }
      if (topic === 'home/sensors/motion') {
        this.motionDetected = msg === '1';
        console.log(
          `[MOTION] MQTT: "${msg}" → motionDetected=${this.motionDetected} → Status: ${this.motionDetected ? '🚨 ALERT' : '✓ SAFE'}`,
        );
      }
    });
  }

  private async handleRfidScan(uid: string) {
    const upperUid = uid.trim().toUpperCase();
    console.log(`[RFID] Scan received: ${upperUid}`);
    const card = await this.rfidCardModel
      .findOne({ uid: upperUid, active: true })
      .exec();
    if (card) {
      console.log(`[RFID] Authorized: ${upperUid} (${card.ownerName})`);
      this.rawMqtt.publish('home/commands', 'UNLOCK_DOOR');
    } else {
      console.log(`[RFID] Rejected: ${upperUid}`);
      this.rawMqtt.publish('home/commands', 'REJECT_DOOR');
    }
  }

  handleDoorbell(data: string) {
    try {
      const key = getEncryptionKeyFromEnv();
      if (!key) {
        console.error('DOORBELL_ENCRYPTION_KEY is missing or invalid');
        return;
      }

      const decrypted = decryptDoorbellPayload(data, key);
      const visitor = (decrypted.person as string) || 'Unknown';
      this.lastVisitor = visitor;
      this.doorbellActive = true;
      this.doorbellEventId += 1;
      console.log(
        `[Doorbell] Visitor detected: ${visitor} (event #${this.doorbellEventId})`,
      );

      // Auto-clear after 60s so the popup doesn't re-fire forever
      if (this.doorbellClearTimer) clearTimeout(this.doorbellClearTimer);
      this.doorbellClearTimer = setTimeout(() => {
        this.doorbellClearTimer = null;
        this.doorbellActive = false;
        this.lastVisitor = 'No one at the door';
      }, 60 * 1000);
    } catch (error) {
      console.error('Decryption failed:', error);
    }
  }

  // Dual-API rain check: returns true only if BOTH OpenWeatherMap and Weatherbit report rain.
  // If only one is available, falls back to that one. If neither, returns false (safe: water).
  private async isRainingDualApi(): Promise<{
    raining: boolean;
    reason: string;
  }> {
    const city = process.env.WEATHER_CITY ?? 'Sousse';
    const owmKey = process.env.OPENWEATHER_KEY;
    const wbKey = process.env.WEATHERBIT_KEY;

    let owmRain: boolean | null = null;
    let wbRain: boolean | null = null;

    // 4-second hard timeout per API so a slow service can't hang the whole server
    const httpOpts = { timeout: 4000 };

    if (owmKey) {
      try {
        const r = await firstValueFrom(
          this.httpService.get<{ weather?: Array<{ main?: string }> }>(
            `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${owmKey}`,
            httpOpts,
          ),
        );
        owmRain = r.data.weather?.[0]?.main === 'Rain';
      } catch {
        owmRain = null;
      }
    }

    if (wbKey) {
      try {
        const r = await firstValueFrom(
          this.httpService.get<{
            data?: Array<{ weather?: { description?: string } }>;
          }>(
            `https://api.weatherbit.io/v2.0/current?city=${encodeURIComponent(city)}&key=${wbKey}`,
            httpOpts,
          ),
        );
        const desc =
          r.data.data?.[0]?.weather?.description?.toLowerCase() ?? '';
        wbRain = desc.includes('rain') || desc.includes('drizzle');
      } catch {
        wbRain = null;
      }
    }

    // Decision: only skip watering if BOTH APIs (that responded) agree it's raining
    if (owmRain === null && wbRain === null) {
      return { raining: false, reason: 'Both weather APIs failed. Watering.' };
    }
    if (owmRain === null) {
      return {
        raining: !!wbRain,
        reason: wbRain ? 'Weatherbit: rain. Skip.' : 'Weatherbit: dry. Water.',
      };
    }
    if (wbRain === null) {
      return {
        raining: !!owmRain,
        reason: owmRain
          ? 'OpenWeather: rain. Skip.'
          : 'OpenWeather: dry. Water.',
      };
    }
    if (owmRain && wbRain) {
      return { raining: true, reason: 'Both APIs confirm rain. Skip.' };
    }
    return {
      raining: false,
      reason: 'APIs disagree on rain. Watering (safe).',
    };
  }

  // Evaluate pump state using latest sensor data and weather when in automatic mode
  private async evaluatePump() {
    if (this.pumpSystemDisabled) {
      this.pumpState = false;
      this.weatherReason = 'Pump System Disabled';
      this.publishDeviceState();
      return;
    }
    if (this.manualPumpOverride) return; // do not override manual control

    try {
      const latest = await this.sensorModel
        .findOne()
        .sort({ timestamp: -1 })
        .exec();
      const soil = latest?.soilMoisture;

      if (typeof soil === 'number' && soil < 30) {
        const { raining, reason } = await this.isRainingDualApi();
        this.pumpState = !raining;
        this.weatherReason = reason;
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

  @Post('update')
  async updateStatus(@Body() newData: SensorUpdateDto) {
    console.log('[POST] /update received');
    let pump = this.pumpState;
    const gasLevel = newData.gasLevel ?? newData.smokeLevel;
    const motionDetected = newData.motionDetected ?? newData.motion ?? false;

    // Civil Protection email alert on gas/smoke (threshold 1200)
    if (typeof gasLevel === 'number') {
      const status = gasLevel > 1200 ? '🔥 FIRE DETECTED' : '✓ Normal';
      console.log(`[SMOKE] Reading: ${gasLevel} (threshold: 1200) ${status}`);
      if (gasLevel > 1200) {
        console.log('[SMOKE] Sending alert email...');
        sendCivilProtectionAlert('SMOKE', {
          gasLevel,
          temperature: newData.tempSalon,
        }).catch((e) => console.error('[Mailer] alert send failed:', e));
      }
    }

    // Motion state is now received via MQTT (no HTTP processing needed)
    // Just store it for getStatus() to return

    if (
      !this.pumpSystemDisabled &&
      !this.manualPumpOverride &&
      typeof newData.soilMoisture === 'number' &&
      newData.soilMoisture < 30
    ) {
      // Use the shared dual-API rain check (with timeouts)
      const { raining, reason } = await this.isRainingDualApi();
      pump = !raining;
      this.weatherReason = reason;
    } else if (this.pumpSystemDisabled) {
      pump = false;
      this.weatherReason = 'Pump System Disabled';
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

    // Real-time motion status from MQTT: 1 = ALERT, 0 = SAFE
    // Doorbell takes precedence
    const latestMotion = this.doorbellActive || this.motionDetected;
    const smokeDanger = latestGasLevel > 1200;

    return {
      tempSalon: latest?.tempSalon ?? 0,
      soilMoisture: latest?.soilMoisture ?? 0,
      gasLevel: latestGasLevel,
      smokeDanger,
      motionDetected: latestMotion,
      lastVisitor: this.lastVisitor,
      doorbellEventId: this.doorbellEventId,
      lights: this.currentLights,
      manualPump: this.manualPumpOverride,
      pumpSystemDisabled: this.pumpSystemDisabled,
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
  async togglePump(@Body() body: { state?: boolean }) {
    if (this.pumpSystemDisabled) {
      // Whole pump system is disabled — manual toggles are no-ops
      return {
        success: false,
        reason: 'Pump system is disabled. Enable it in Settings first.',
        manualPump: false,
        pump: false,
        weatherReason: 'Pump System Disabled',
      };
    }

    const newState =
      typeof body.state === 'boolean' ? body.state : !this.pumpState;

    if (newState === true) {
      // ON  -> manual mode, pump runs until user toggles off
      this.manualPumpOverride = true;
      this.pumpState = true;
      this.weatherReason = 'Manual Mode: Pump ON';
      console.log('[Pump] Manual ON');
    } else {
      // OFF -> back to AUTOMATIC mode, run the dual-API rain check immediately
      this.manualPumpOverride = false;
      console.log(
        '[Pump] Switching to AUTOMATIC mode (dual weather API check)',
      );
      await this.evaluatePump();
    }

    this.publishDeviceState();
    return {
      success: true,
      manualPump: this.manualPumpOverride,
      pump: this.pumpState,
      weatherReason: this.weatherReason,
    };
  }

  // Kill switch: disable the entire pump system (overrides both manual and automatic modes)
  @Post('toggle-pump-system')
  togglePumpSystem(@Body() body: { disabled?: boolean }) {
    const newDisabled =
      typeof body.disabled === 'boolean'
        ? body.disabled
        : !this.pumpSystemDisabled;

    this.pumpSystemDisabled = newDisabled;

    if (newDisabled) {
      // Force pump off and clear manual override
      this.pumpState = false;
      this.manualPumpOverride = false;
      this.weatherReason = 'Pump System Disabled';
      console.log('[Pump] System DISABLED → pumpState=false, will publish "0"');
    } else {
      // Re-enabled — return to automatic mode and evaluate immediately
      this.manualPumpOverride = false;
      this.weatherReason = 'Automatic Mode: Re-enabled';
      console.log('[Pump] System RE-ENABLED — switching to automatic mode');
      this.evaluatePump().catch((e) =>
        console.error('Pump evaluation failed:', e),
      );
    }

    console.log(
      `[Pump] publishDeviceState() called. disabled=${this.pumpSystemDisabled}`,
    );
    this.publishDeviceState();
    return {
      success: true,
      pumpSystemDisabled: this.pumpSystemDisabled,
      pump: this.pumpState,
      manualPump: this.manualPumpOverride,
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
    // Clear motion and doorbell states (motion state still comes from MQTT)
    this.motionDetected = false;
    if (this.doorbellClearTimer) {
      clearTimeout(this.doorbellClearTimer);
      this.doorbellClearTimer = null;
    }
    this.doorbellActive = false;
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
    this.rawMqtt.publish('home/commands', command, (err) => {
      if (err) console.error('MQTT publish failed:', err);
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
    } catch (error) {
      console.error('Error publishing sensor data to MQTT:', error);
    }
  }

  private publishDeviceState() {
    // rawMqtt may not exist yet if called before setupRawMqtt() completes
    if (!this.rawMqtt) return;

    // MASTER LOCK: pumpSystemDisabled overrides everything
    if (this.pumpSystemDisabled) this.pumpState = false;

    const pumpPayload = this.pumpState ? '1' : '0';
    console.log(`[PUMP] publish home/devices/pump = ${pumpPayload}`);

    this.rawMqtt.publish('home/devices/pump', pumpPayload);
    this.rawMqtt.publish('home/devices/garage', this.garageOpen ? '1' : '0');
    Object.entries(this.currentLights).forEach(([room, state]) => {
      const topic = `home/devices/light_${room.toUpperCase().replace(/ /g, '_')}`;
      this.rawMqtt.publish(topic, state ? '1' : '0');
    });
  }
}
