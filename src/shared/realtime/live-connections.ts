import { Global, Injectable, Module } from '@nestjs/common';

interface LiveConnection {
  sessionId: string;
  userId: string;
  close: () => void;
}

/**
 * As ligações em tempo real abertas nesta instância, por sessão. Serve para
 * as fechar quando a sessão acaba: no logout, na troca de password e na
 * suspensão da conta. Sem isto, um socket aberto antes da suspensão ficava a
 * enviar e a receber até cair sozinho.
 *
 * Vive em memória, por isso só conhece as ligações desta instância. Com mais
 * de uma, quem fecha as das outras é a verificação da sessão em cada evento.
 */
@Injectable()
export class LiveConnections {
  private readonly connections = new Set<LiveConnection>();

  /** Regista uma ligação. Devolve a função que a tira do registo. */
  register(connection: LiveConnection): () => void {
    this.connections.add(connection);

    return () => {
      this.connections.delete(connection);
    };
  }

  /** Fecha as ligações de uma sessão. Devolve quantas fechou. */
  closeSession(sessionId: string): number {
    return this.closeWhere((connection) => connection.sessionId === sessionId);
  }

  /**
   * Fecha as ligações de uma conta. Com `exceptSessionId` fica de fora a
   * sessão de quem fez o pedido.
   */
  closeUser(userId: string, exceptSessionId?: string): number {
    return this.closeWhere(
      (connection) =>
        connection.userId === userId &&
        connection.sessionId !== exceptSessionId,
    );
  }

  /** Quantas ligações estão abertas. */
  get size(): number {
    return this.connections.size;
  }

  private closeWhere(matches: (connection: LiveConnection) => boolean): number {
    const toClose = [...this.connections].filter(matches);

    for (const connection of toClose) {
      this.connections.delete(connection);
      connection.close();
    }

    return toClose.length;
  }
}

@Global()
@Module({
  providers: [LiveConnections],
  exports: [LiveConnections],
})
export class RealtimeModule {}
