# @waterfell/agentic-team

A library for coordinating teams of AI agents working together toward a shared goal.

## Overview

`@waterfell/agentic-team` provides coordination primitives for managing a team of AI agents, where a manager agent delegates tasks to team members and coordinates their work. It builds on [@waterfell/agentic-loop](../agentic-loop) to provide multi-agent orchestration with task management, inter-agent communication, and automatic task queueing.

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
npm install @waterfell/agentic-team @waterfell/agentic-loop
```

## Quick Example

```typescript
import { createAgentTeam } from '@waterfell/agentic-team';

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
    systemPrompt: 'You are a project manager. Break down the goal into tasks and assign them to your team.',
  },
  team: [
    {
      id: 'Bailey#1',
      role: 'backend_engineer',
      systemPrompt: 'You are a backend engineer. Implement server-side features.',
    },
    {
      id: 'Alex#1',
      role: 'frontend_engineer',
      systemPrompt: 'You are a frontend engineer. Build user interfaces.',
    }
  ],
  callbacks: {
    onTaskCreated: (task) => console.log('Task created:', task.id),
    onTaskCompleted: (task) => console.log('Task completed:', task.id),
    onGoalComplete: (summary) => console.log('Goal complete:', summary),
  }
});

// Run the manager to delegate work
await team.runAgent('Morgan#1');

// Run team members on their assigned tasks
const workItems = team.getNextWork();
for (const work of workItems) {
  await team.runAgent(work.agentId);
}

// Check if goal is complete
if (team.isGoalComplete()) {
  console.log('All done!');
}
```

## Core Concepts

### Manager and Team Members

- **Manager**: Special agent that assigns tasks and coordinates the team
- **Team Members**: Agents that execute tasks assigned by the manager
- Both run using the agentic-loop library with their own system prompts and tools

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
  resumeFrom?: AgentTeamState;       // Resume from previous state
  callbacks?: TeamCallbacks;         // Event callbacks for persistence
  logger?: Logger;                   // Custom logger
  maxTurnsPerSession?: number;       // Max turns per agent run (default: 50)
  tokenLimit?: number;               // Token limit for summarization
}
```

**Returns:** `AgentTeam` object

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
import { createAgentTeam } from '@waterfell/agentic-team';

const team = createAgentTeam({
  teamId: 'feature-auth',
  goal: 'Implement user authentication with login and signup',
  modelConfig: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKey: '...' },
  manager: {
    id: 'Morgan#1',
    systemPrompt: 'You are an engineering manager...'
  },
  team: [
    { id: 'Bailey#1', role: 'backend', systemPrompt: '...' },
    { id: 'Alex#1', role: 'frontend', systemPrompt: '...' }
  ]
});

// 1. Manager breaks down the goal and assigns tasks
console.log('Running manager...');
const managerResult = await team.runAgent('Morgan#1');

if (managerResult.completed) {
  console.log('Manager completed goal immediately!');
}

// 2. Run team members on assigned tasks
while (!team.isGoalComplete()) {
  const workItems = team.getNextWork();
  
  if (workItems.length === 0) {
    // Check for blocked agents
    const blocked = team.getBlockedAgents();
    if (blocked.length > 0) {
      console.log('Agents are blocked waiting for replies:', blocked);
      // In a real app, you'd wait for external replies (e.g., from BigBoss via UI)
      break;
    }
    break;
  }
  
  // Run each agent with work
  for (const work of workItems) {
    console.log(`Running ${work.agentId} on task ${work.taskId}...`);
    const result = await team.runAgent(work.agentId);
    
    if (result.suspended) {
      console.log(`${work.agentId} is blocked:`, result.suspendInfo);
    } else if (result.completed) {
      console.log(`${work.agentId} completed their task!`);
    }
  }
  
  // After agents complete tasks, run manager again to process notifications
  console.log('Running manager to review completions...');
  await team.runAgent('Morgan#1');
}

if (team.isGoalComplete()) {
  console.log('Goal complete!', team.state.goalSummary);
}
```

## Handling External Communication

When an agent asks an external entity (like "BigBoss"), you need to handle the reply:

```typescript
// Agent asks BigBoss
const result = await team.runAgent('Bailey#1');
if (result.suspended && result.suspendInfo?.data.to === 'BigBoss') {
  const messageId = result.suspendInfo.data.messageId;
  
  // Get answer from human (via UI, CLI, etc.)
  const humanAnswer = await promptHuman('Bailey asks: ' + message.content);
  
  // Deliver reply
  const agentToResume = team.deliverMessageReply(messageId, humanAnswer);
  
  // Resume the agent
  if (agentToResume) {
    await team.runAgent(agentToResume);
  }
}
```

## License

MIT