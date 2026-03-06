import { Bridge } from './bridge.js';
import { TimerManager } from './timerManager.js';
import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
  PERMISSION_EXEMPT_TOOLS,
} from './constants.js';
import type { AgentState } from './models.js';

export class TranscriptParser {
  constructor(
    private bridge: Bridge,
    private timerManager: TimerManager,
  ) {}

  formatToolStatus(toolName: string, input: Record<string, any>): string {
    const baseName = (key: string): string => {
      const v = input[key];
      if (typeof v !== 'string') return '';
      const parts = v.split('/');
      return parts[parts.length - 1];
    };

    switch (toolName) {
      case 'Read': return `Reading ${baseName('file_path')}`;
      case 'Edit': return `Editing ${baseName('file_path')}`;
      case 'Write': return `Writing ${baseName('file_path')}`;
      case 'Bash': {
        const cmd = input.command ?? '';
        const truncated = cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
          ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026'
          : cmd;
        return `Running: ${truncated}`;
      }
      case 'Glob': return 'Searching files';
      case 'Grep': return 'Searching code';
      case 'WebFetch': return 'Fetching web content';
      case 'WebSearch': return 'Searching the web';
      case 'Task': {
        const desc = input.description ?? '';
        if (desc) {
          const truncated = desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH
            ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026'
            : desc;
          return `Subtask: ${truncated}`;
        }
        return 'Running subtask';
      }
      case 'AskUserQuestion': return 'Waiting for your answer';
      case 'EnterPlanMode': return 'Planning';
      case 'ExitPlanMode': return 'Finishing plan';
      case 'NotebookEdit': return 'Editing notebook';
      default: return `Using ${toolName}`;
    }
  }

  processTranscriptLine(agentId: number, line: string, agents: Map<number, AgentState>) {
    const agent = agents.get(agentId);
    if (!agent) return;

    try {
      const record = JSON.parse(line);
      const type = record.type;
      if (!type) return;

      switch (type) {
        case 'assistant':
          this.processAssistantRecord(agentId, agent, record, agents);
          break;
        case 'progress':
          this.processProgressRecord(agentId, record, agents);
          break;
        case 'user':
          this.processUserRecord(agentId, agent, record, agents);
          break;
        case 'system':
          if (record.subtype === 'turn_duration') {
            this.timerManager.cancelWaitingTimer(agentId);
            this.timerManager.cancelPermissionTimer(agentId);
            if (agent.activeToolIds.size > 0) {
              agent.activeToolIds.clear();
              agent.activeToolStatuses.clear();
              agent.activeToolNames.clear();
              agent.activeSubagentToolIds.clear();
              agent.activeSubagentToolNames.clear();
              this.bridge.postMessage({ type: 'agentToolsClear', id: agentId });
            }
            agent.isWaiting = true;
            agent.permissionSent = false;
            agent.hadToolsInTurn = false;
            this.bridge.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
          }
          break;
      }
    } catch {
      // Ignore malformed lines
    }
  }

  private processAssistantRecord(
    agentId: number,
    agent: AgentState,
    record: any,
    agents: Map<number, AgentState>,
  ) {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    const hasToolUse = content.some((b: any) => b.type === 'tool_use');

    // Process thinking blocks
    for (const block of content) {
      if (block.type === 'thinking') {
        const thinking = block.thinking;
        if (typeof thinking !== 'string') continue;
        const words = thinking.trim().split(/\s+/);
        if (words.length < 3) continue;
        const summary = words.slice(0, 8).join(' ') + '...';
        this.bridge.postMessage({ type: 'agentThinking', id: agentId, text: summary });
      }
    }

    if (hasToolUse) {
      this.timerManager.cancelWaitingTimer(agentId);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      this.bridge.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

      let hasNonExemptTool = false;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const blockId = block.id;
          const toolName = block.name ?? '';
          const input = block.input ?? {};
          const status = this.formatToolStatus(toolName, input);

          console.log(`[Stormies] Agent ${agentId} tool start: ${blockId} ${status}`);
          agent.activeToolIds.add(blockId);
          agent.activeToolStatuses.set(blockId, status);
          agent.activeToolNames.set(blockId, toolName);

          if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
            hasNonExemptTool = true;
          }

          this.bridge.postMessage({
            type: 'agentToolStart', id: agentId, toolId: blockId, status,
          });
        }
      }
      if (hasNonExemptTool) {
        this.timerManager.startPermissionTimer(agentId, agents);
      }
    } else {
      const hasText = content.some((b: any) => b.type === 'text');
      if (hasText && !agent.hadToolsInTurn) {
        this.timerManager.startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents);
      }
    }
  }

  private processUserRecord(
    agentId: number,
    agent: AgentState,
    record: any,
    agents: Map<number, AgentState>,
  ) {
    const message = record.message;
    if (!message) return;
    const content = message.content;

    if (Array.isArray(content)) {
      const hasToolResult = content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id;
            if (!toolUseId) continue;
            console.log(`[Stormies] Agent ${agentId} tool done: ${toolUseId}`);

            if (agent.activeToolNames.get(toolUseId) === 'Task') {
              agent.activeSubagentToolIds.delete(toolUseId);
              agent.activeSubagentToolNames.delete(toolUseId);
              this.bridge.postMessage({ type: 'subagentClear', id: agentId, parentToolId: toolUseId });
            }

            agent.activeToolIds.delete(toolUseId);
            agent.activeToolStatuses.delete(toolUseId);
            agent.activeToolNames.delete(toolUseId);

            const capturedToolId = toolUseId;
            this.bridge.schedule(() => {
              this.bridge.postMessage({ type: 'agentToolDone', id: agentId, toolId: capturedToolId });
            }, TOOL_DONE_DELAY_MS);
          }
        }
        if (agent.activeToolIds.size === 0) {
          agent.hadToolsInTurn = false;
        }
      } else {
        this.timerManager.cancelWaitingTimer(agentId);
        this.timerManager.clearAgentActivity(agent, agentId);
        agent.hadToolsInTurn = false;
      }
    } else if (typeof content === 'string' && content.trim()) {
      this.timerManager.cancelWaitingTimer(agentId);
      this.timerManager.clearAgentActivity(agent, agentId);
      agent.hadToolsInTurn = false;
    }
  }

  private processProgressRecord(
    agentId: number,
    record: any,
    agents: Map<number, AgentState>,
  ) {
    const agent = agents.get(agentId);
    if (!agent) return;
    const parentToolId = record.parentToolUseID;
    const data = record.data;
    if (!parentToolId || !data) return;
    const dataType = data.type;

    if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
      if (agent.activeToolIds.has(parentToolId)) {
        this.timerManager.startPermissionTimer(agentId, agents);
      }
      return;
    }

    if (agent.activeToolNames.get(parentToolId) !== 'Task') return;

    const msg = data.message;
    if (!msg) return;
    const msgType = msg.type;
    const innerMsg = msg.message;
    if (!innerMsg) return;
    const content = innerMsg.content;
    if (!Array.isArray(content)) return;

    switch (msgType) {
      case 'assistant':
        this.processSubagentAssistant(agentId, agent, parentToolId, content, agents);
        break;
      case 'user':
        this.processSubagentUser(agentId, agent, parentToolId, content, agents);
        break;
    }
  }

  private processSubagentAssistant(
    agentId: number,
    agent: AgentState,
    parentToolId: string,
    content: any[],
    agents: Map<number, AgentState>,
  ) {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use') {
        const blockId = block.id;
        const toolName = block.name ?? '';
        const input = block.input ?? {};
        const status = this.formatToolStatus(toolName, input);

        console.log(`[Stormies] Agent ${agentId} subagent tool start: ${blockId} ${status} (parent: ${parentToolId})`);

        if (!agent.activeSubagentToolIds.has(parentToolId)) {
          agent.activeSubagentToolIds.set(parentToolId, new Set());
        }
        agent.activeSubagentToolIds.get(parentToolId)!.add(blockId);

        if (!agent.activeSubagentToolNames.has(parentToolId)) {
          agent.activeSubagentToolNames.set(parentToolId, new Map());
        }
        agent.activeSubagentToolNames.get(parentToolId)!.set(blockId, toolName);

        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }

        this.bridge.postMessage({
          type: 'subagentToolStart', id: agentId, parentToolId, toolId: blockId, status,
        });
      }
    }
    if (hasNonExemptSubTool) {
      this.timerManager.startPermissionTimer(agentId, agents);
    }
  }

  private processSubagentUser(
    agentId: number,
    agent: AgentState,
    parentToolId: string,
    content: any[],
    agents: Map<number, AgentState>,
  ) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id;
        if (!toolUseId) continue;
        console.log(`[Stormies] Agent ${agentId} subagent tool done: ${toolUseId} (parent: ${parentToolId})`);

        agent.activeSubagentToolIds.get(parentToolId)?.delete(toolUseId);
        agent.activeSubagentToolNames.get(parentToolId)?.delete(toolUseId);

        const capturedToolId = toolUseId;
        this.bridge.schedule(() => {
          this.bridge.postMessage({
            type: 'subagentToolDone', id: agentId, parentToolId, toolId: capturedToolId,
          });
        }, TOOL_DONE_DELAY_MS);
      }
    }

    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt) {
      this.timerManager.startPermissionTimer(agentId, agents);
    }
  }
}
