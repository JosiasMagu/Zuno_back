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
  // ── Throttle no refresh ────────────────────────────────────────────────────
  // Endpoint sem limite é o alvo natural de força bruta após obtenção de um
  // token. 20 pedidos por minuto é suficiente para qualquer uso legítimo
  // (apps mobile com reconexão automática) e bloqueia tentativas de ataque.
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
