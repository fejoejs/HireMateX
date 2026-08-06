import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateApplicationDto {
  @IsString()
  @IsNotEmpty()
  jobId: string;
}

export class UpdateStatusDto {
  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateCoverLetterDto {
  @IsString()
  @IsNotEmpty()
  coverLetter: string;
}
