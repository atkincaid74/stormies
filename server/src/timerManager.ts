import { Bridge, type Cancellable } from './bridge.js';
import { PERMISSION_TIMER_DELAY_MS, PERMISSION_EXEMPT_TOOLS } from './constants.js';
import type { AgentState } from './models.js';

export class TimerManager {
  private waitingTimers = new Map<number, Cancellable>();
  private permissionTimers = new Map<number, Cancellable>();

  constructor(private bridge: Bridge) {}

  clearAgentActivity(agent: AgentState | undefined, agentId: number) {
    if (!agent) return;
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    agent.isWaiting = false;
    agent.permissionSent = false;
    this.cancelPermissionTimer(agentId);
    this.bridge.postMessage({ type: 'agentToolsClear', id: agentId });
    this.bridge.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
  }

  cancelWaitingTimer(agentId: number) {
    this.waitingTimers.get(agentId)?.cancel();
    this.waitingTimers.delete(agentId);
  }

  startWaitingTimer(agentId: number, delayMs: number, agents: Map<number, AgentState>) {
    this.cancelWaitingTimer(agentId);
    const timer = this.bridge.schedule(() => {
      this.waitingTimers.delete(agentId);
      const agent = agents.get(agentId);
      if (agent) agent.isWaiting = true;
      this.bridge.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }, delayMs);
    this.waitingTimers.set(agentId, timer);
  }

  cancelPermissionTimer(agentId: number) {
    this.permissionTimers.get(agentId)?.cancel();
    this.permissionTimers.delete(agentId);
  }

  startPermissionTimer(agentId: number, agents: Map<number, AgentState>) {
    this.cancelPermissionTimer(agentId);
    const timer = this.bridge.schedule(() => {
      this.permissionTimers.delete(agentId);
      const agent = agents.get(agentId);
      if (!agent) return;

      let hasNonExempt = false;
      for (const toolId of agent.activeToolIds) {
        const toolName = agent.activeToolNames.get(toolId) ?? '';
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExempt = true;
          break;
        }
      }

      const stuckSubagentParentToolIds: string[] = [];
      for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
        for (const [, toolName] of subToolNames) {
          if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
            stuckSubagentParentToolIds.push(parentToolId);
            hasNonExempt = true;
            break;
          }
        }
      }

      if (hasNonExempt) {
        agent.permissionSent = true;
        console.log(`[Stormies] Agent ${agentId}: possible permission wait detected`);
        this.bridge.postMessage({ type: 'agentToolPermission', id: agentId });
        for (const parentToolId of stuckSubagentParentToolIds) {
          this.bridge.postMessage({ type: 'subagentToolPermission', id: agentId, parentToolId });
        }
      }
    }, PERMISSION_TIMER_DELAY_MS);
    this.permissionTimers.set(agentId, timer);
  }

  dispose() {
    for (const t of this.waitingTimers.values()) t.cancel();
    this.waitingTimers.clear();
    for (const t of this.permissionTimers.values()) t.cancel();
    this.permissionTimers.clear();
  }
}
