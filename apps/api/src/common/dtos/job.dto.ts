import {
  IsEmail,
  IsObject,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpdateFiltersDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsObject()
  @IsNotEmpty()
  filters: any;
}
