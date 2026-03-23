import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Sensor extends Document {
  @Prop() tempSalon: number;
  @Prop() soilMoisture: number;
  @Prop() gasLevel: number;
  @Prop() isRaining: boolean;
  @Prop() motionDetected: boolean;
  @Prop() manualPump: boolean;
  @Prop({ default: Date.now }) timestamp: Date;
}
export const SensorSchema = SchemaFactory.createForClass(Sensor);
