import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Sensor extends Document {
  @Prop() tempLivingRoom!: number;
  @Prop() tempSalon!: number;
  @Prop() soilMoisture!: number;
  @Prop() gasLevel!: number;
  @Prop() motionDetected!: boolean;
  @Prop() manualPump!: boolean;
  @Prop({ default: false }) garageOpen!: boolean;
  @Prop({ default: true }) proximityEnabled!: boolean;
  @Prop({
    type: Object,
    default: {
      'Living Room': false,
      Bedroom: false,
      Kitchen: false,
      Garage: false,
    },
  })
  roomLights!: Record<string, boolean>;
  @Prop({ default: Date.now }) timestamp!: Date;
}
export const SensorSchema = SchemaFactory.createForClass(Sensor);
