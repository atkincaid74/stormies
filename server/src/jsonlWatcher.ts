import fs from 'fs';
import { Bridge, type Cancellable } from './bridge.js';
import { TimerManager } from './timerManager.js';
import { TranscriptParser } from './transcriptParser.js';
import { FILE_WATCHER_POLL_INTERVAL_MS } from './constants.js';
import type { AgentState } from './models.js';

export class JsonlWatcher {
  private pollingTimers = new Map<number, Cancellable>();

  constructor(
    private bridge: Bridge,
    private timerManager: TimerManager,
    private transcriptParser: TranscriptParser,
    private agents: Map<number, AgentState>,
  ) {}

  startFileWatching(agentId: number, _filePath: string) {
    const timer = this.bridge.schedule(() => {
      if (!this.agents.has(agentId)) {
        this.stopFileWatching(agentId);
        return;
      }
      this.readNewLines(agentId);
    }, FILE_WATCHER_POLL_INTERVAL_MS, true);
    this.pollingTimers.set(agentId, timer);
  }

  readNewLines(agentId: number) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      if (!fs.existsSync(agent.jsonlFile)) return;
      const stat = fs.statSync(agent.jsonlFile);
      const fileSize = stat.size;
      if (fileSize <= agent.fileOffset) return;

      const bytesToRead = fileSize - agent.fileOffset;
      const buf = Buffer.alloc(bytesToRead);

      const fd = fs.openSync(agent.jsonlFile, 'r');
      try {
        fs.readSync(fd, buf, 0, bytesToRead, agent.fileOffset);
      } finally {
        fs.closeSync(fd);
      }
      agent.fileOffset = fileSize;

      const text = agent.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      agent.lineBuffer = lines[lines.length - 1];
      const completeLines = lines.slice(0, -1);

      const hasLines = completeLines.some(l => l.trim().length > 0);
      if (hasLines) {
        this.timerManager.cancelWaitingTimer(agentId);
        this.timerManager.cancelPermissionTimer(agentId);
        if (agent.permissionSent) {
          agent.permissionSent = false;
          this.bridge.postMessage({ type: 'agentToolPermissionClear', id: agentId });
        }
      }

      for (const line of completeLines) {
        if (!line.trim()) continue;
        this.transcriptParser.processTranscriptLine(agentId, line, this.agents);
      }
    } catch (e) {
      console.warn(`[Stormies] Read error for agent ${agentId}:`, e);
    }
  }

  stopFileWatching(agentId: number) {
    this.pollingTimers.get(agentId)?.cancel();
    this.pollingTimers.delete(agentId);
  }

  dispose() {
    for (const t of this.pollingTimers.values()) t.cancel();
    this.pollingTimers.clear();
  }
}
