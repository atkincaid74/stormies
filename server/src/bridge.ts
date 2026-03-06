import { WebSocket } from 'ws';

export interface Cancellable {
  cancel(): void;
}

export class Bridge {
  private clients = new Set<WebSocket>();
  private messageHandler?: (msg: Record<string, any>, sender: WebSocket) => void;

  addClient(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.messageHandler?.(msg, ws);
      } catch (e) {
        console.warn('[Stormies] Error parsing client message:', e);
      }
    });
    ws.on('close', () => this.clients.delete(ws));
  }

  onMessage(handler: (msg: Record<string, any>, sender: WebSocket) => void) {
    this.messageHandler = handler;
  }

  postMessage(msg: Record<string, any>) {
    const json = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  sendTo(ws: WebSocket, msg: Record<string, any>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  schedule(fn: () => void, delayMs: number, repeat = false): Cancellable {
    if (repeat) {
      const id = setInterval(() => {
        try { fn(); } catch (e) { console.warn('[Stormies] Timer error:', e); }
      }, delayMs);
      return { cancel: () => clearInterval(id) };
    }
    const id = setTimeout(() => {
      try { fn(); } catch (e) { console.warn('[Stormies] Timer error:', e); }
    }, delayMs);
    return { cancel: () => clearTimeout(id) };
  }

  dispose() {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
