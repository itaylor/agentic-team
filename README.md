# @itaylor/agentic-team

A library for coordinating teams of AI agents working together toward a shared goal.

## Overview

`@itaylor/agentic-team` provides coordination primitives for managing a team of AI agents, where a manager agent delegates tasks to team members and coordinates their work. It builds on [@itaylor/agentic-loop](../agentic-loop) to provide multi-agent orchestration with task management, inter-agent communication, and automatic task queueing.

## Why does this exist?
It's my belief that the best Agentic Coding UI may not be the terminal or the IDE, but something else that we haven't seen yet. Whatever that other UI paradigm may be, there's a need to have an agent that oversees the work of other agents, and coordinates their work towards a shared goal.  This is an attempt to implement that pattern that is detached from any particular UI or specific sets of team rules that we may wish to enforce.

## Features

- **Task Management**: Assign tasks to agents, track completion, automatic queueing
- **Inter-Agent Communication**: Ask/tell messaging with automatic suspension/resumption
- **Manager Delegation**: Manager agent coordinates team and delegates work
- **Built-in Coordination Tools**: Task assignment, status checking, messaging
- **Event-Based Persistence**: Callbacks for all state changes (tasks, messages, completions)
- **Resumable Sessions**: Full state can be persisted and restored across restarts
- **Blocking Semantics**: Agents suspend when waiting for replies, resume when answered

## Installation

```bash
npm install @itaylor/agentic-team @itaylor/agentic-loop
```

## Quick Example

```typescript
import { createAgentTeam } from '@itaylor/agentic-team';

// Create a team
const team = createAgentTeam({
  teamId: 'project-001',
  goal: 'Implement user authentication feature',
  modelConfig: {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: process.env.ANTHROPIC_API_KEY
  },
  manager: {
    id: 'Morgan#1',
    role: 'manager',
    // systemPrompt is optional — defaults to a generic manager prompt
    // The library provides the manager with goal context and workflow instructions automatically
  },
  team: [
    {
      id: 'Bailey#1',
      role: 'backend_engineer',
      // systemPrompt is optional — defaults to a role-based prompt
    },
    {
      id: 'Alex#1',
      role: 'frontend_engineer',
    }
  ],
  callbacks: {
    onTaskCreated: (task) => console.log('Task created:', task.id),
    onTaskCompleted: (task) => console.log('Task completed:', task.id),
    onGoalComplete: (summary) => console.log('Goal complete:', summary),
  }
});

// Run the team autonomously until goal is complete
const result = await team.run();

console.log('Goal complete:', result.complete);
console.log('Iterations:', result.iterations);
```

## Core Concepts

### Manager and Team Members

- **Manager**: Special agent that assigns tasks and coordinates the team
- **Team Members**: Agents that execute tasks assigned by the manager
- Both run using the agentic-loop library with their own system prompts and tools
- **System prompts are optional** — the library provides sensible defaults. The manager automatically receives goal context and workflow instructions as its first message; workers receive their task brief and standard completion instructions.

### Tasks

Tasks have a lifecycle:
1. **queued**: Task is assigned but agent is busy
2. **active**: Agent is currently working on this task
3. **completed**: Agent finished and called `task_complete`

Agents work on one task at a time. Additional tasks are queued automatically.

### Messages

Agents communicate via `ask` and `tell`:
- **ask**: Sends a question and suspends the agent until reply arrives
- **tell**: Sends a message or reply to a question

When an agent calls `ask`, their session suspends (using agentic-loop's suspension mechanism). When a reply is delivered, the agent can be resumed.

The manager can also suspend by calling `wait_for_task_completions()` after assigning work. This prevents the manager from looping unnecessarily while waiting for team members to finish. The manager automatically resumes when task completion notifications arrive.

### Built-in Tools

**Manager Tools:**
- `assign_task(assignee, title, brief)` - Create and assign a task
- `wait_for_task_completions()` - Wait for assigned tasks to complete (suspends)
- `check_team_status()` - See all agents and tasks
- `ask(to, question)` - Ask agent or external entity (suspends)
- `tell(to, message, inReplyTo?)` - Send message
- `task_complete(summary)` - Complete the overall goal (built-in from agentic-loop)

**Team Member Tools:**
- `get_task_brief()` - Re-read current task details
- `ask(to, question)` - Ask for help (suspends)
- `tell(to, message, inReplyTo?)` - Send message
- `task_complete(summary)` - Complete current task (built-in from agentic-loop)

## API

### `createAgentTeam(config)`

Creates a new agent team coordinator.

**Config:**
```typescript
{
  teamId: string;                    // Unique team identifier
  goal: string;                      // Overall goal the team is working toward
  modelConfig: ModelConfig;          // LLM configuration
  manager: ManagerConfig;            // Manager agent configuration
  team: TeamMember[];                // Team member configurations
  resumeFrom?: AgentTeamState;       // Resume from previous state (for crash recovery)
  callbacks?: TeamCallbacks;         // Event callbacks for persistence
  logger?: Logger;                   // Custom logger
  maxTurnsPerSession?: number;       // Max turns per agent run (default: 50)
  tokenLimit?: number;               // Token limit for summarization
}
```

**TeamMember / ManagerConfig:**
```typescript
{
  id: string;           // Unique agent identifier (e.g. "Bailey#1")
  role: string;         // Role label (e.g. "backend_engineer")
  systemPrompt?: string; // Optional — library provides a default if omitted
  tools?: Record<string, Tool>; // Domain-specific tools (coordination tools added automatically)
}
```

If you want to give your agents code editing capabilities (read/write files, search, apply patches, etc.), consider using [agent-mcp](https://github.com/itaylor/agent-mcp) to supply tools via the MCP stdio protocol:

```typescript
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createMCPClient } from "@ai-sdk/mcp";

const transport = new Experimental_StdioMCPTransport({
  command: "/path/to/agent-mcp",
  args: ["/path/to/your/repo"],
});
const mcpClient = await createMCPClient({ transport });
const mcpTools = await mcpClient.tools();

const team = createAgentTeam({
  // ...
  team: [
    {
      id: "Bailey#1",
      role: "backend_engineer",
      tools: mcpTools, // agent-mcp tools merged with built-in coordination tools
    },
  ],
});

await team.run();
await mcpClient.close();
```

**Returns:** `AgentTeam` object

### `team.run()`

Run the team autonomously until the goal is complete or agents are blocked waiting for external input (like BigBoss replies).

**Returns:** `Promise<{ complete: boolean, blockedAgents: Array<{ agentId, messageId }>, iterations: number }>`

This is the primary way to use the library - just call `run()` and the team coordinates itself automatically.

### `team.runAgent(agentId)`

Run an agent (manager or team member). The agent will work on their current task or process messages.

**Returns:** `Promise<AgentRunResult>`
```typescript
{
  agentId: string;
  completed?: boolean;               // True if task completed
  suspended?: boolean;               // True if agent blocked
  suspendInfo?: { reason, data };    // Suspension details
  finalOutput: string;               // Agent's final message
  completionReason: string;          // How session ended
}
```

### `team.getNextWork()`

Get agents that have active tasks ready to work on.

**Returns:** `WorkItem[]`
```typescript
{
  agentId: string;
  taskId: string;
  task: Task;
}
```

### `team.getBlockedAgents()`

Get agents that are blocked waiting for message replies.

**Returns:** `Array<{ agentId, messageId }>`

### `team.deliverMessageReply(messageId, replyContent)`

Deliver a reply to a message, unblocking the waiting agent.

**Returns:** `string | null` - The agent ID that should be resumed, or null if not found

### `team.isGoalComplete()`

Check if the overall goal has been completed (manager called `task_complete`).

**Returns:** `boolean`

## Event Callbacks

All callbacks are optional and can be used for persistence, logging, or UI updates:

```typescript
{
  onTaskCreated: (task: Task) => void;
  onTaskActivated: (task: Task) => void;
  onTaskCompleted: (task: Task) => void;
  onMessageSent: (message: TeamMessage) => void;
  onMessageDelivered: (message: TeamMessage) => void;
  onAgentBlocked: (agentId: string, messageId: string) => void;
  onAgentUnblocked: (agentId: string) => void;
  onGoalComplete: (summary: string) => void;
  onStateChange: (state: AgentTeamState) => void;
}
```

## Persistence and Resumption

The library is designed to be stateless - all state is in the `AgentTeamState` object which can be serialized and restored:

```typescript
// Save state
const state = team.state;
await fs.writeFile('team-state.json', JSON.stringify(state));

// Resume later (even after server restart)
const savedState = JSON.parse(await fs.readFile('team-state.json'));
const team = createAgentTeam({
  ...config,
  resumeFrom: savedState
});
```

Note: The `agentStates` Map needs special handling for JSON serialization:

```typescript
// Serialize
const stateForSave = {
  ...state,
  agentStates: Array.from(state.agentStates.entries())
};

// Deserialize
const loaded = JSON.parse(savedData);
const state = {
  ...loaded,
  agentStates: new Map(loaded.agentStates)
};
```

## Example: Full Workflow

```typescript
import { createAgentTeam } from '@itaylor/agentic-team';

const team = createAgentTeam({
  teamId: 'feature-auth',
  goal: 'Implement user authentication with login and signup',
  modelConfig: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKey: '...' },
  manager: {
    id: 'Morgan#1',
    role: 'manager',
    // No systemPrompt needed — the library provides goal context and workflow instructions
  },
  team: [
    { id: 'Bailey#1', role: 'backend_engineer' },
    { id: 'Alex#1', role: 'frontend_engineer' }
  ]
});
```

// Run the team autonomously
const result = await team.run();

if (result.complete) {
  console.log('Goal complete!', team.state.goalSummary);
  console.log('Completed in', result.iterations, 'iterations');
} else if (result.blockedAgents.length > 0) {
  console.log('Blocked on external input:', result.blockedAgents);
  // Handle external questions (e.g., from BigBoss via UI)
  // Then call team.run() again to resume
}
```

## Handling External Communication

When an agent asks an external entity (like "BigBoss"), `team.run()` returns with blocked agents:

```typescript
// Run team
const result = await team.run();

if (!result.complete && result.blockedAgents.length > 0) {
  for (const blocked of result.blockedAgents) {
    const message = team.state.messages.find(m => m.id === blocked.messageId);
    if (message && message.to === 'BigBoss') {
      // Get answer from human (via UI, CLI, etc.)
      const humanAnswer = await promptHuman(message.content);
      
      // Deliver reply
      team.deliverMessageReply(blocked.messageId, humanAnswer);
    }
  }
  
  // Resume team
  const resumedResult = await team.run();
}
```

## License

MIT
