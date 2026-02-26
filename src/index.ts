// Public API for @itaylor/agentic-team

export { createAgentTeam } from "./agent-team.js";

export type {
  // Core types
  TeamMember,
  ManagerConfig,
  AgentTeamConfig,
  AgentTeam,
  AgentTeamState,
  AgentState,
  Task,
  TeamMessage,
  WorkItem,
  AgentRunResult,
  TeamCallbacks,
  // Re-exported from agentic-loop
  Message,
  ModelConfig,
  Logger,
  SessionCallbacks,
} from "./types.js";
