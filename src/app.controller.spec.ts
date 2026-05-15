import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AppController } from './app.controller';
import { getModelToken } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';
import { RfidCard } from './rfid-card.schema';

describe('AppController', () => {
  let appController: AppController;

  const mockUserModel = {
    findOne: jest.fn(),
    save: jest.fn(),
    countDocuments: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    updateOne: jest.fn(),
  };

  const mockSensorModel = {
    findOne: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        exec: jest
          .fn<() => Promise<{ tempSalon: number }>>()
          .mockResolvedValue({ tempSalon: 25 }),
      }),
    }),
  };

  const mockRfidCardModel = {
    findOne: jest.fn(),
  };

  const mockHttpService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const app = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(Sensor.name),
          useValue: mockSensorModel,
        },
        {
          provide: getModelToken(RfidCard.name),
          useValue: mockRfidCardModel,
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
  });

  it('should return system status', async () => {
    const status = await appController.getStatus();
    expect(status).toHaveProperty('systemInfo');
    expect(status.systemInfo.userName).toBe('Raed');
  });

  it('should authorize active RFID cards by uid', async () => {
    mockRfidCardModel.findOne.mockReturnValueOnce({
      exec: jest.fn(() =>
        Promise.resolve({ uid: 'A1B2C3', ownerName: 'Raed' }),
      ),
    });

    const result = await appController.authorizeRfid({ uid: 'a1b2c3' });

    expect(result.authorized).toBe(true);
    expect(result.uid).toBe('A1B2C3');
    expect(result.ownerName).toBe('Raed');
  });
});