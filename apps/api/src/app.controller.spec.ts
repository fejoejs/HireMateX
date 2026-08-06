import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SystemConfigService } from './system-config/system-config.service';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const mockSystemConfigService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('should return health status', () => {
      const health = appController.getHealth();
      expect(health.status).toBe('ok');
      expect(health.timestamp).toBeDefined();
    });

    it('should return system features', async () => {
      const features = await appController.getFeatures();
      expect(features.ats).toBe(true);
      expect(features.optimizer).toBe(true);
    });
  });
});
