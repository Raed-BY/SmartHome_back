import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class User extends Document {
  @Prop({ required: true }) name!: string;
  @Prop({ required: true, unique: true }) email!: string;
  @Prop({ required: true }) pass!: string;
  @Prop({ default: false }) biometricEnabled?: boolean;
}
export const UserSchema = SchemaFactory.createForClass(User);
