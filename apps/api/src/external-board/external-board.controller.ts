import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ExternalBoardService } from './external-board.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { ExtensionAuthGuard } from '../auth/extension-auth.guard';
import { GetUserId } from '../auth/get-user.decorator';

@Controller()
export class ExternalBoardController {
  constructor(private readonly externalBoardService: ExternalBoardService) {}

  @Get('user/extension-token')
  @UseGuards(FirebaseAuthGuard)
  async getExtensionToken(@GetUserId() userId: string) {
    const token = await this.externalBoardService.getExtensionToken(userId);
    return { token };
  }

  @Post('external-board/receive')
  @UseGuards(ExtensionAuthGuard)
  async receiveJob(@Body() dto: any, @GetUserId() userId: string) {
    if (Array.isArray(dto)) {
      return this.externalBoardService.saveOrRefreshBatch(userId, dto);
    }
    if (dto && Array.isArray(dto.jobs)) {
      return this.externalBoardService.saveOrRefreshBatch(userId, dto.jobs);
    }
    return this.externalBoardService.saveOrRefresh(userId, dto);
  }

  @Get('external-board/list')
  @UseGuards(FirebaseAuthGuard)
  async getList(@GetUserId() userId: string) {
    return this.externalBoardService.getFilteredJobs(userId);
  }

  @Post('external-board/:id/mark-pending')
  @UseGuards(FirebaseAuthGuard)
  async markPending(@Param('id') jobId: string, @GetUserId() userId: string) {
    return this.externalBoardService.markPending(userId, jobId);
  }

  @Post('external-board/:id/confirm-applied')
  @UseGuards(FirebaseAuthGuard)
  async confirmApplied(
    @Param('id') jobId: string,
    @GetUserId() userId: string,
  ) {
    return this.externalBoardService.confirmApplied(userId, jobId);
  }

  @Post('external-board/:id/confirm-not-applied')
  @UseGuards(FirebaseAuthGuard)
  async confirmNotApplied(
    @Param('id') jobId: string,
    @GetUserId() userId: string,
  ) {
    return this.externalBoardService.clearPending(userId, jobId);
  }

  @Post('external-board/:id/dismiss')
  @UseGuards(FirebaseAuthGuard)
  async dismissJob(@Param('id') jobId: string, @GetUserId() userId: string) {
    return this.externalBoardService.dismissJob(userId, jobId);
  }
}
