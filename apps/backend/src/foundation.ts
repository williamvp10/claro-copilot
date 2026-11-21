import { Controller, Get, Module } from '@nestjs/common';
import { CaseSnapshot } from '@claro/contracts';

@Controller()
class FoundationController {
  @Get('healthz')
  health() { return { status: 'ok' }; }

  @Get('api/v1/foundation/smoke')
  smoke() {
    return CaseSnapshot.parse({
      id: 'case-synthetic', conversation_id: 'conversation-synthetic', display_name: 'Cliente de prueba',
      channel: 'telegram', attention_mode: 'autoservicio', owner_id: null, verified: false, status: 'open',
      revision: 1, updated_at: '2026-11-18T12:00:00Z', last_message: 'Consulta de plan', cursor: 1,
      messages: [{ id: 'turn-synthetic', turn_seq: 1, actor: 'cliente', text: 'Consulta de plan', created_at: '2026-11-18T12:00:00Z' }],
      card: null
    });
  }
}

@Module({ controllers: [FoundationController] })
export class FoundationModule {}
