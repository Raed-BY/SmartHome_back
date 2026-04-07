import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AppController } from './app.controller';
import { getModelToken } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import type { Request } from 'express';
import { User } from './user.schema';
import { Sensor } from './sensor.schema';

describe('AppController', () => {
  let appController: AppController;

  // Create fake versions of the database models
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
    save: jest.fn(),
  };

  const mockHttpService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        // We "provide" the fake models to the controller
        {
          provide: getModelToken(User.name),
          useValue: mockUserModel,
        },
        {
          provide: getModelToken(Sensor.name),
          useValue: mockSensorModel,
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

  describe('getStatus', () => {
    it('should return system status', async () => {
      const status = await appController.getStatus({
        headers: {},
        ip: '127.0.0.1',
      } as Request);
      expect(status).toHaveProperty('systemInfo');
      expect(status.systemInfo.userName).toBe('Guest');
    });
  });
});
