const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

let ws: WebSocket | null = null;
let messageQueue: unknown[] = [];

function connect() {
  ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

  ws.onopen = () => {
    for (const msg of messageQueue) {
      ws!.send(JSON.stringify(msg));
    }
    messageQueue = [];
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      window.postMessage(data, '*');
    } catch { /* ignore malformed messages */ }
  };

  ws.onclose = () => {
    ws = null;
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

connect();

export const vscode = {
  postMessage(msg: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      messageQueue.push(msg);
    }
  },
};
