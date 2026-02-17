// Core types for the agentic-team library

import type { Tool } from "ai";
import type {
  Message,
  ModelConfig,
  Logger,
  SessionCallbacks,
} from "@waterfell/agentic-loop";

// Re-export types from agentic-loop for convenience
export type { Message, ModelConfig, Logger, SessionCallbacks };

/**
 * Configuration for a team member (agent)
 */
export interface TeamMember {
  /** Unique identifier for this agent (e.g., "Bailey#1") */
  id: string;
  /** Role label (e.g., "backend_engineer") - just a label, not enforced */
  role: string;
  /** System prompt for this agent */
  systemPrompt: string;
  /** Domain-specific tools available to this agent (coordination tools added automatically) */
  tools?: Record<string, Tool>;
}

/**
 * Configuration for the manager agent
 */
export interface ManagerConfig extends TeamMember {
  role: "manager";
}

/**
 * A task assigned to a team member
 */
export interface Task {
  /** Unique task identifier (e.g., "T-0001") */
  id: string;
  /** Short task title */
  title: string;
  /** Detailed task description/brief */
  brief: string;
  /** Agent assigned to this task */
  assignee: string;
  /** Who created/assigned this task */
  createdBy: string;
  /** Current task status */
  status: "queued" | "active" | "completed";
  /** When the task was created */
  createdAt: string;
  /** When the task was completed (if completed) */
  completedAt?: string;
  /** Completion summary from the agent (if completed) */
  completionSummary?: string;
}

/**
 * A message between team members or to/from external entities
 */
export interface TeamMessage {
  /** Unique message identifier (e.g., "M-0001") */
  id: string;
  /** Who sent the message */
  from: string;
  /** Who receives the message */
  to: string;
  /** Message type */
  type: "ask" | "tell";
  /** Message content */
  content: string;
  /** If this is a reply, the message ID being replied to */
  inReplyTo?: string;
  /** Message status */
  status: "pending" | "delivered";
  /** When the message was created */
  createdAt: string;
}

/**
 * State of an individual agent
 */
export interface AgentState {
  /** Agent identifier */
  id: string;
  /** Role label */
  role: string;
  /** Current status */
  status: "idle" | "working" | "blocked";
  /** Current task ID (if working) */
  currentTask?: string;
  /** Message ID the agent is blocked on (if blocked) */
  blockedOn?: string;
  /** Full conversation history for this agent */
  conversationHistory: Message[];
}

/**
 * Overall team state
 */
export interface AgentTeamState {
  /** All tasks */
  tasks: Task[];
  /** All messages */
  messages: TeamMessage[];
  /** State of each agent (keyed by agent ID) */
  agentStates: Map<string, AgentState>;
  /** Whether the overall goal has been completed */
  goalComplete: boolean;
  /** Goal completion summary (if complete) */
  goalSummary?: string;
}

/**
 * Event callbacks for team coordination
 */
export interface TeamCallbacks {
  /** Called when a new task is created */
  onTaskCreated?: (task: Task) => void | Promise<void>;

  /** Called when a task is activated (moves from queued to active) */
  onTaskActivated?: (task: Task) => void | Promise<void>;

  /** Called when a task is completed */
  onTaskCompleted?: (task: Task) => void | Promise<void>;

  /** Called when a message is sent */
  onMessageSent?: (message: TeamMessage) => void | Promise<void>;

  /** Called when a message is delivered/answered */
  onMessageDelivered?: (message: TeamMessage) => void | Promise<void>;

  /** Called when an agent becomes blocked waiting for a response */
  onAgentBlocked?: (agentId: string, messageId: string) => void | Promise<void>;

  /** Called when a blocked agent is unblocked */
  onAgentUnblocked?: (agentId: string) => void | Promise<void>;

  /** Called when the overall goal is completed */
  onGoalComplete?: (summary: string) => void | Promise<void>;

  /** Called when state changes (can be used for general persistence) */
  onStateChange?: (state: AgentTeamState) => void | Promise<void>;
}

/**
 * Configuration for creating an agent team
 */
export interface AgentTeamConfig {
  /** Unique identifier for this team/project */
  teamId: string;

  /** The overall goal this team is working toward */
  goal: string;

  /** Model configuration for LLM calls */
  modelConfig: ModelConfig;

  /** The manager agent configuration */
  manager: ManagerConfig;

  /** Team member configurations */
  team: TeamMember[];

  /** Resume from previous state (optional) */
  resumeFrom?: AgentTeamState;

  /** Optional callback to generate task IDs (for continuous IDs across systems) */
  generateTaskId?: (existingTasks: Task[]) => string;

  /** Optional callback to generate message IDs (for continuous IDs across systems) */
  generateMessageId?: (existingMessages: TeamMessage[]) => string;

  /** Event callbacks for persistence and monitoring */
  callbacks?: TeamCallbacks;

  /** Logger implementation (defaults to console) */
  logger?: Logger;

  /** Maximum turns for any single agent session (default: 50) */
  maxTurnsPerSession?: number;

  /** Token limit for agent sessions (triggers summarization) */
  tokenLimit?: number;

  /**
   * Optional factory to create additional session callbacks for each agent run.
   * Called before each agent session starts. The returned callbacks are merged
   * with the team's internal callbacks (internal ones always run first).
   * Use this to wire in transcript management or other per-agent monitoring.
   */
  sessionCallbacksFactory?: (
    agentId: string,
  ) => Promise<SessionCallbacks> | SessionCallbacks;
}

/**
 * Information about work that needs to be done
 */
export interface WorkItem {
  /** Agent who should do the work */
  agentId: string;
  /** Task to work on */
  taskId: string;
  /** Task details */
  task: Task;
}

/**
 * Result of running an agent
 */
export interface AgentRunResult {
  /** Agent that was run */
  agentId: string;

  /** Whether the agent completed their task */
  completed?: boolean;

  /** Whether the agent is suspended (blocked) */
  suspended?: boolean;

  /** Suspension details (if suspended) */
  suspendInfo?: {
    reason: string;
    data?: any;
  };

  /** Final output/message from the agent */
  finalOutput: string;

  /** How the session ended */
  completionReason: "task_complete" | "suspended" | "max_turns" | "error";

  /** Error details (if error) */
  error?: Error;
}

/**
 * The agent team coordinator
 */
export interface AgentTeam {
  /** Unique team identifier */
  readonly teamId: string;

  /**
   * Run the team autonomously until the goal is complete or blocked
   * Returns when goal is complete or agents are blocked waiting for external input
   */
  run(): Promise<{
    complete: boolean;
    blockedAgents: Array<{ agentId: string; messageId: string }>;
    iterations: number;
  }>;

  /**
   * Stop the team run loop gracefully
   * Returns a promise that resolves with the current state when actually stopped
   * The returned state can be used to resume the team later
   */
  stop(): Promise<AgentTeamState>;

  /**
   * Deliver a message reply to resume a blocked agent
   * Call this to answer questions from agents, then call run() again to continue
   */
  deliverMessageReply(messageId: string, replyContent: string): void;
}
