import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUserId } from '../auth/get-user.decorator';
import { ApplicationService } from './application.service';
import {
  CreateApplicationDto,
  UpdateStatusDto,
  UpdateCoverLetterDto,
} from '../common/dtos/application.dto';

@Controller('application')
@UseGuards(FirebaseAuthGuard)
export class ApplicationController {
  constructor(private readonly appService: ApplicationService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async createApplication(
    @GetUserId() userId: string,
    @Body() body: CreateApplicationDto,
  ) {
    return this.appService.createApplication(userId, body.jobId);
  }

  @Get()
  async getApplications(@GetUserId() userId: string) {
    return this.appService.getApplications(userId);
  }

  @Post(':id/tailor')
  async triggerTailoring(
    @GetUserId() userId: string,
    @Param('id') appId: string,
  ) {
    return this.appService.requestTailoring(userId, appId);
  }

  @Post(':id/submit-greenhouse')
  async submitToGreenhouse(
    @GetUserId() userId: string,
    @Param('id') appId: string,
  ) {
    return this.appService.submitToGreenhouse(userId, appId);
  }

  @Post(':id/self-report')
  async selfReportApplied(
    @GetUserId() userId: string,
    @Param('id') appId: string,
  ) {
    return this.appService.selfReportApplied(userId, appId);
  }

  @Post('self-report-job')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async selfReportJob(
    @GetUserId() userId: string,
    @Body() body: CreateApplicationDto,
  ) {
    return this.appService.createSelfReportedApplication(userId, body.jobId);
  }

  @Post(':id/apply')
  async markAsApplied(@GetUserId() userId: string, @Param('id') appId: string) {
    return this.appService.markAsApplied(userId, appId);
  }

  @Put(':id/status')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async updateStatus(
    @GetUserId() userId: string,
    @Param('id') appId: string,
    @Body() body: UpdateStatusDto,
  ) {
    return this.appService.updateStatus(userId, appId, body.status, body.notes);
  }

  @Put(':id/cover-letter')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async updateCoverLetter(
    @GetUserId() userId: string,
    @Param('id') appId: string,
    @Body() body: UpdateCoverLetterDto,
  ) {
    return this.appService.updateCoverLetter(userId, appId, body.coverLetter);
  }

  @Get(':id/download-tailored')
  async downloadTailored(
    @GetUserId() userId: string,
    @Param('id') appId: string,
    @Res() res: Response,
  ) {
    const { content, fileName } = await this.appService.getTailoredResumeFile(
      userId,
      appId,
    );
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(content);
  }
}
