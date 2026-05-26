import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { BranchAccessGuard } from './guards/branch-access.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // JwtModule registered without secret — each sign() call passes its own secret
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  // BranchAccessGuard is exported so any feature module can attach it via @UseGuards(BranchAccessGuard).
  // It depends on PrismaService which is provided globally by PrismaModule.
  providers: [AuthService, JwtStrategy, BranchAccessGuard],
  exports: [AuthService, JwtStrategy, PassportModule, BranchAccessGuard],
})
export class AuthModule {}
