import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AuthService } from '../services/auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import {
  ChangePasswordDto,
  ConfirmPhoneVerificationDto,
  ForgotPasswordDto,
  RequestPhoneVerificationDto,
  ResetPasswordDto,
} from '../dto/verification.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Registrar novo utilizador' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: 201,
    description: 'Utilizador registrado com sucesso.',
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos.' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Autenticar utilizador' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 201, description: 'Login realizado com sucesso.' })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  // Throttle no refresh
  // Endpoint sem limite e o alvo natural de forca bruta apos obtencao de um
  // token. 20 pedidos por minuto e suficiente para qualquer uso legitimo
  // (apps mobile com reconexao automatica) e bloqueia tentativas de ataque.
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: 'Renovar access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 201, description: 'Token renovado com sucesso.' })
  @ApiResponse({ status: 401, description: 'Refresh token inválido.' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @Post('logout')
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Encerrar sessão do utilizador' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 201, description: 'Logout realizado com sucesso.' })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Post('verify/request')
  @Throttle({ global: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Pedir codigo de verificacao por telefone' })
  @ApiBody({ type: RequestPhoneVerificationDto })
  @ApiResponse({ status: 201, description: 'Pedido aceite.' })
  requestPhoneVerification(@Body() dto: RequestPhoneVerificationDto) {
    return this.authService.requestPhoneVerification(dto);
  }

  @Post('verify/confirm')
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Confirmar codigo de verificacao por telefone' })
  @ApiBody({ type: ConfirmPhoneVerificationDto })
  @ApiResponse({ status: 201, description: 'Conta verificada.' })
  @ApiResponse({ status: 400, description: 'Codigo invalido ou expirado.' })
  confirmPhoneVerification(@Body() dto: ConfirmPhoneVerificationDto) {
    return this.authService.confirmPhoneVerification(dto);
  }

  @Post('password/forgot')
  @Throttle({ global: { ttl: 60_000, limit: 3 } })
  @ApiOperation({
    summary: 'Iniciar redefinicao de password',
    description:
      'Resposta generica para evitar enumeracao de utilizadores. O codigo so e enviado se a conta existir.',
  })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 201, description: 'Pedido aceite.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('password/reset')
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Concluir redefinicao de password com codigo' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 201, description: 'Password redefinida com sucesso.' })
  @ApiResponse({ status: 400, description: 'Codigo invalido ou expirado.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('password/change')
  @ApiBearerAuth('access-token')
  @Throttle({ global: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Alterar password (requer password actual)' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 201, description: 'Password alterada com sucesso.' })
  @ApiResponse({ status: 401, description: 'Password actual incorrecta.' })
  changePassword(
    @CurrentUser() user: { id: string },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter dados do utilizador autenticado' })
  @ApiResponse({
    status: 200,
    description: 'Dados do utilizador retornados com sucesso.',
  })
  @ApiResponse({ status: 401, description: 'Não autenticado.' })
  me(@CurrentUser() user: { id: string }) {
    return this.authService.getMe(user.id);
  }
}
