import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});
@Post('login')
async login(@Body() body: any) {
  const { email, password } = body;
  // Test simple : on accepte si le mot de passe est "admin123"
  if (email === "admin@home.com" && password === "admin123") {
    return { success: true, token: "fake-jwt-token", user: "Raed" };
  } else {
    return { success: false, message: "Identifiants incorrects" };
  }
}