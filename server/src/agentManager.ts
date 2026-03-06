import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import { Bridge, type Cancellable } from './bridge.js';
import { TimerManager } from './timerManager.js';
import { JsonlWatcher } from './jsonlWatcher.js';
import { PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import type { AgentState } from './models.js';
import { createAgentState } from './models.js';

export class AgentManager {
  private nextAgentId = 1;
  private knownJsonlFiles = new Set<string>();
  private projectScanTimers = new Map<string, Cancellable>();
  private parentScanTimer: Cancellable | null = null;
  private scanning = false;

  constructor(
    private bridge: Bridge,
    private timerManager: TimerManager,
    private jsonlWatcher: JsonlWatcher,
    public agents: Map<number, AgentState>,
  ) {}

  /** Discover all Claude project directories (no filtering — all projects). */
  getProjectDirs(): string[] {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
      if (!fs.existsSync(claudeProjectsDir)) return [];
      return fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(claudeProjectsDir, d.name));
    } catch {
      return [];
    }
  }

  startProjectScanning() {
    if (this.scanning) return;
    this.scanning = true;

    const projectDirs = this.getProjectDirs();
    for (const dir of projectDirs) {
      this.ensureProjectScan(dir);
    }

    // Scan for new project directories periodically
    this.parentScanTimer = this.bridge.schedule(() => {
      const currentDirs = this.getProjectDirs();
      for (const dir of currentDirs) {
        this.ensureProjectScan(dir);
      }
    }, PROJECT_SCAN_INTERVAL_MS * 5, true);
  }

  private ensureProjectScan(projectDir: string) {
    if (this.projectScanTimers.has(projectDir)) return;

    // Scan existing JSONL files on first discovery
    const recentThresholdMs = 5 * 60 * 1000;
    const now = Date.now();
    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(projectDir, f));

      for (const filePath of files) {
        this.knownJsonlFiles.add(filePath);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs < recentThresholdMs) {
          console.log(`[Stormies] Active JSONL found at startup: ${path.basename(filePath)}`);
          this.createAgentForFile(filePath, projectDir);
        }
      }
    } catch { /* ignore */ }

    const timer = this.bridge.schedule(() => {
      this.scanForNewJsonlFiles(projectDir);
    }, PROJECT_SCAN_INTERVAL_MS, true);
    this.projectScanTimers.set(projectDir, timer);
  }

  private scanForNewJsonlFiles(projectDir: string) {
    try {
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(projectDir, f));

      for (const filePath of files) {
        if (!this.knownJsonlFiles.has(filePath)) {
          this.knownJsonlFiles.add(filePath);
          console.log(`[Stormies] New JSONL detected: ${path.basename(filePath)}`);
          this.createAgentForFile(filePath, projectDir);
        }
      }
    } catch { /* ignore */ }
  }

  private createAgentForFile(jsonlFile: string, projectDir: string) {
    const id = this.nextAgentId++;
    const agent = createAgentState(id, projectDir, jsonlFile);
    this.agents.set(id, agent);
    console.log(`[Stormies] Agent ${id}: created for ${path.basename(jsonlFile)}`);
    this.bridge.postMessage({ type: 'agentCreated', id });

    this.jsonlWatcher.startFileWatching(id, jsonlFile);
    this.jsonlWatcher.readNewLines(id);
  }

  removeAgent(agentId: number) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.jsonlWatcher.stopFileWatching(agentId);
    this.timerManager.cancelWaitingTimer(agentId);
    this.timerManager.cancelPermissionTimer(agentId);
    this.agents.delete(agentId);
  }

  /** Send existing agent data to a specific client. */
  sendExistingAgents(sender: WebSocket, agentMeta: Record<string, any> = {}) {
    const agentIds = [...this.agents.keys()].sort((a, b) => a - b);
    this.bridge.sendTo(sender, {
      type: 'existingAgents',
      agents: agentIds,
      agentMeta,
      folderNames: {},
    });

    // Send current tool statuses
    for (const [agentId, agent] of this.agents) {
      for (const [toolId, status] of agent.activeToolStatuses) {
        this.bridge.sendTo(sender, { type: 'agentToolStart', id: agentId, toolId, status });
      }
      if (agent.isWaiting) {
        this.bridge.sendTo(sender, { type: 'agentStatus', id: agentId, status: 'waiting' });
      }
    }
  }

  dispose() {
    this.parentScanTimer?.cancel();
    for (const t of this.projectScanTimers.values()) t.cancel();
    this.projectScanTimers.clear();
    for (const id of [...this.agents.keys()]) {
      this.removeAgent(id);
    }
  }
}
