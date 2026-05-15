import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class RfidCard extends Document {
  @Prop({ required: true, unique: true, index: true })
  uid!: string;

  @Prop({ default: '' })
  ownerName!: string;

  @Prop({ default: true })
  active!: boolean;

  @Prop({ default: '' })
  notes!: string;
}

export const RfidCardSchema = SchemaFactory.createForClass(RfidCard);
