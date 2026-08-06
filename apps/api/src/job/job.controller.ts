import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUserId } from '../auth/get-user.decorator';
import { JobService } from './job.service';
import { UpdateFiltersDto } from '../common/dtos/job.dto';

import { AdminGuard } from '../auth/admin.guard';

@Controller('job')
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Post('filters')
  @UseGuards(FirebaseAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async updateFilters(
    @GetUserId() userId: string,
    @Body() body: UpdateFiltersDto,
  ) {
    return this.jobService.updateFilters(userId, body.email, body.filters);
  }

  @Get('dashboard')
  @UseGuards(FirebaseAuthGuard)
  async getDashboard(@GetUserId() userId: string) {
    return this.jobService.getDashboardJobs(userId);
  }

  @Get('integrations')
  @UseGuards(FirebaseAuthGuard)
  async getJobIntegrations() {
    return this.jobService.getIntegrationStatuses();
  }

  @Post(':id/match')
  @UseGuards(FirebaseAuthGuard)
  async triggerMatch(@GetUserId() userId: string, @Param('id') jobId: string) {
    return this.jobService.requestJobMatch(userId, jobId);
  }

  @Post(':id/dismiss')
  @UseGuards(FirebaseAuthGuard)
  async dismissJob(@GetUserId() userId: string, @Param('id') jobId: string) {
    return this.jobService.dismissJob(userId, jobId);
  }

  @Post('system/trigger-global-crawl')
  @UseGuards(FirebaseAuthGuard, AdminGuard)
  async triggerGlobalCrawl() {
    this.jobService
      .crawlGlobalJobs()
      .catch((e) => console.error('[JobController] Crawl failed:', e));
    return { status: 'Crawl triggered successfully' };
  }
}
