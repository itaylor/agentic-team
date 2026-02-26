// Agent team coordinator - manages a team of agents working toward a goal

import { runAgentSession } from "@itaylor/agentic-loop";
import type {
  AgentSession,
  SessionSuspendInfo,
  SessionCallbacks,
  Message as LoopMessage,
} from "@itaylor/agentic-loop";
import type { Tool } from "ai";
import { z } from "zod";
import type {
  AgentTeam,
  AgentTeamConfig,
  AgentTeamState,
  AgentState,
  AgentRunResult,
  Task,
  TeamMessage,
  WorkItem,
  Message,
  Logger,
  ModelConfig,
} from "./types.js";

/**
 * Default logger implementation
 */
const defaultLogger: Logger = {
  error: (message: string, ...args: any[]) => console.error(message, ...args),
  info: (message: string, ...args: any[]) => console.info(message, ...args),
  trace: (message: string, ...args: any[]) => console.debug(message, ...args),
};

/**
 * Generate a task ID
 */
function generateTaskId(existingTasks: Task[]): string {
  const maxId = existingTasks.reduce((max, task) => {
    const num = parseInt(task.id.replace("T-", ""), 10);
    return num > max ? num : max;
  }, 0);
  return `T-${String(maxId + 1).padStart(4, "0")}`;
}

/**
 * Generate a message ID
 */
function generateMessageId(existingMessages: TeamMessage[]): string {
  const maxId = existingMessages.reduce((max, msg) => {
    const num = parseInt(msg.id.replace("M-", ""), 10);
    return num > max ? num : max;
  }, 0);
  return `M-${String(maxId + 1).padStart(4, "0")}`;
}

/**
 * Create an agent team coordinator
 */
export function createAgentTeam(config: AgentTeamConfig): AgentTeam {
  const logger = config.logger || defaultLogger;

  // Initialize state
  const state: AgentTeamState = config.resumeFrom || {
    tasks: [],
    messages: [],
    agentStates: new Map(),
    goalComplete: false,
  };

  // Initialize agent states if not resuming
  if (!config.resumeFrom) {
    // Manager state
    state.agentStates.set(config.manager.id, {
      id: config.manager.id,
      role: "manager",
      status: "idle",
      conversationHistory: [],
    });

    // Team member states
    for (const member of config.team) {
      state.agentStates.set(member.id, {
        id: member.id,
        role: member.role,
        status: "idle",
        conversationHistory: [],
      });
    }
  }

  /**
   * Create coordination tools for an agent
   */
  function createCoordinationTools(agentId: string): Record<string, Tool> {
    const isManager = agentId === config.manager.id;

    const tools: Record<string, Tool> = {
      ask: {
        description:
          "Ask another team member or external entity a question. Your session will pause until they reply.",
        inputSchema: z.object({
          to: z
            .string()
            .describe(
              "Who to ask (agent ID like 'Bailey#1' or 'BigBoss' for external)",
            ),
          question: z.string().describe("Your question"),
        }),
        execute: async (args: { to: string; question: string }) => {
          const messageId = config.generateMessageId
            ? config.generateMessageId(state.messages)
            : generateMessageId(state.messages);
          const message: TeamMessage = {
            id: messageId,
            from: agentId,
            to: args.to,
            type: "ask",
            content: args.question,
            status: "pending",
            createdAt: new Date().toISOString(),
          };

          state.messages.push(message);
          await config.callbacks?.onMessageSent?.(message);

          logger.info(
            `Agent ${agentId} asked ${args.to}: ${args.question.substring(0, 50)}...`,
          );

          // Return suspension signal
          return {
            __suspend__: true,
            reason: "waiting_for_reply",
            data: { messageId, to: args.to },
          };
        },
      },

      tell: {
        description:
          "Send a message to another team member or reply to a question.",
        inputSchema: z.object({
          to: z.string().describe("Who to send the message to"),
          message: z.string().describe("Your message"),
          inReplyTo: z
            .string()
            .optional()
            .describe("Message ID if replying to a question"),
        }),
        execute: async (args: {
          to: string;
          message: string;
          inReplyTo?: string;
        }) => {
          const messageId = config.generateMessageId
            ? config.generateMessageId(state.messages)
            : generateMessageId(state.messages);
          const message: TeamMessage = {
            id: messageId,
            from: agentId,
            to: args.to,
            type: "tell",
            content: args.message,
            status: "delivered",
            createdAt: new Date().toISOString(),
            inReplyTo: args.inReplyTo,
          };

          state.messages.push(message);

          // Find the ask this is replying to - either explicitly via inReplyTo,
          // or auto-detect if the recipient has a pending ask from the sender
          let originalAsk: TeamMessage | undefined;
          if (args.inReplyTo) {
            originalAsk = state.messages.find(
              (m) => m.id === args.inReplyTo && m.type === "ask",
            );
          } else {
            // Auto-detect: if the recipient is blocked waiting for a reply from this sender,
            // treat this tell as the reply (LLMs often omit inReplyTo)
            const recipientState = state.agentStates.get(args.to);
            if (
              recipientState &&
              recipientState.status === "blocked" &&
              recipientState.blockedOn
            ) {
              const pendingAsk = state.messages.find(
                (m) =>
                  m.id === recipientState.blockedOn &&
                  m.type === "ask" &&
                  m.from === args.to &&
                  m.to === agentId,
              );
              if (pendingAsk) {
                originalAsk = pendingAsk;
                message.inReplyTo = pendingAsk.id;
                logger.info(
                  `Auto-matched tell from ${agentId} to ${args.to} as reply to ${pendingAsk.id}`,
                );
              }
            }
          }

          if (originalAsk) {
            originalAsk.status = "delivered";
            await config.callbacks?.onMessageDelivered?.(originalAsk);

            // Unblock the agent that sent the original ask
            const askerState = state.agentStates.get(originalAsk.from);
            if (askerState && askerState.blockedOn === originalAsk.id) {
              askerState.status = askerState.currentTask ? "working" : "idle";
              askerState.blockedOn = undefined;

              // Add the reply to their conversation history so they see it when resumed
              askerState.conversationHistory.push({
                role: "user",
                content: `Reply to your question from ${agentId}:\n\n${args.message}`,
              });

              await config.callbacks?.onAgentUnblocked?.(originalAsk.from);
              logger.info(
                `Agent ${originalAsk.from} unblocked by reply from ${agentId} to ${originalAsk.id}`,
              );
            }
          }

          await config.callbacks?.onMessageSent?.(message);

          logger.info(
            `Agent ${agentId} told ${args.to}: ${args.message.substring(0, 50)}...`,
          );

          return {
            success: true,
            messageId,
          };
        },
      },

      get_task_brief: {
        description: "Get the detailed brief for your current task",
        inputSchema: z.object({}),
        execute: async () => {
          const agentState = state.agentStates.get(agentId);
          if (!agentState?.currentTask) {
            return { error: "You have no current task assigned" };
          }

          const task = state.tasks.find((t) => t.id === agentState.currentTask);
          if (!task) {
            return { error: "Task not found" };
          }

          return {
            taskId: task.id,
            title: task.title,
            brief: task.brief,
            status: task.status,
          };
        },
      },

      check_team_status: {
        description: "Check the status of all team members and their tasks",
        inputSchema: z.object({}),
        execute: async () => {
          const teamStatus = Array.from(state.agentStates.values()).map(
            (agent) => {
              const agentTasks = state.tasks.filter(
                (t) => t.assignee === agent.id,
              );
              const activeTasks = agentTasks.filter(
                (t) => t.status === "active",
              );
              const queuedTasks = agentTasks.filter(
                (t) => t.status === "queued",
              );
              const completedTasks = agentTasks.filter(
                (t) => t.status === "completed",
              );

              return {
                agentId: agent.id,
                role: agent.role,
                status: agent.status,
                currentTask: agent.currentTask,
                blockedOn: agent.blockedOn,
                activeTasks: activeTasks.length,
                queuedTasks: queuedTasks.length,
                completedTasks: completedTasks.length,
              };
            },
          );

          return {
            teamSize: state.agentStates.size,
            agents: teamStatus,
            totalTasks: state.tasks.length,
            activeTasks: state.tasks.filter((t) => t.status === "active")
              .length,
            queuedTasks: state.tasks.filter((t) => t.status === "queued")
              .length,
            completedTasks: state.tasks.filter((t) => t.status === "completed")
              .length,
          };
        },
      },
    };

    // Manager-only tools
    if (isManager) {
      tools.assign_task = {
        description:
          "Assign a task to a team member. They will start working on it automatically if available.",
        inputSchema: z.object({
          assignee: z
            .string()
            .describe("Team member to assign to (e.g., 'Bailey#1')"),
          title: z.string().describe("Short task title"),
          brief: z
            .string()
            .describe(
              "Detailed task description with objectives and deliverables",
            ),
        }),
        execute: async (args: {
          assignee: string;
          title: string;
          brief: string;
        }) => {
          // Check if assignee exists
          const assigneeState = state.agentStates.get(args.assignee);
          if (!assigneeState) {
            return {
              error: `Unknown team member: ${args.assignee}`,
            };
          }

          // Create task
          const taskId = config.generateTaskId
            ? config.generateTaskId(state.tasks)
            : generateTaskId(state.tasks);
          const task: Task = {
            id: taskId,
            title: args.title,
            brief: args.brief,
            assignee: args.assignee,
            createdBy: agentId,
            status: "queued",
            createdAt: new Date().toISOString(),
          };

          // If assignee is idle, make this task active
          if (!assigneeState.currentTask) {
            task.status = "active";
            assigneeState.currentTask = taskId;
            assigneeState.status = "working";
          }

          state.tasks.push(task);
          await config.callbacks?.onTaskCreated?.(task);

          if (task.status === "active") {
            await config.callbacks?.onTaskActivated?.(task);
          }

          logger.info(
            `Task ${taskId} assigned to ${args.assignee}: ${args.title}`,
          );

          return {
            success: true,
            taskId,
            status: task.status,
            message:
              task.status === "active"
                ? `Task ${taskId} assigned and activated`
                : `Task ${taskId} queued (agent is busy)`,
          };
        },
      };

      tools.wait_for_task_completions = {
        description:
          "Wait for assigned tasks to be completed. Call this after you've assigned all tasks and are waiting for your team to finish their work. Your session will pause until task completions arrive.",
        inputSchema: z.object({}),
        execute: async () => {
          // Check for incomplete tasks
          const incompleteTasks = state.tasks.filter(
            (t) => t.status === "active" || t.status === "queued",
          );

          if (incompleteTasks.length === 0) {
            return {
              allComplete: true,
              message:
                "All tasks are complete. You can now call task_complete to finish your work.",
            };
          }

          // Suspend to wait for completions
          logger.info(
            `Manager waiting for ${incompleteTasks.length} incomplete tasks`,
          );

          return {
            __suspend__: true,
            reason: "waiting_for_task_completions",
            data: {
              incompleteTasks: incompleteTasks.map((t) => t.id),
              count: incompleteTasks.length,
            },
          };
        },
      };
    }

    return tools;
  }

  /**
   * Build the default system prompt for an agent if none is provided
   */
  function buildDefaultSystemPrompt(agentId: string): string {
    if (agentId === config.manager.id) {
      return "You are a project manager coordinating a team of AI agents.";
    }
    const member = config.team.find((m) => m.id === agentId);
    return `You are a ${member?.role || "team member"} on a collaborative AI team.`;
  }

  /**
   * Build initial message for an agent based on their state
   */
  function buildInitialMessage(agentId: string): string | undefined {
    const agentState = state.agentStates.get(agentId);
    if (!agentState) {
      return undefined;
    }

    const isManager = agentId === config.manager.id;
    const parts: string[] = [];

    // Manager first-time startup: include goal + standard lifecycle instructions
    if (isManager && agentState.conversationHistory.length === 0) {
      const teamList =
        config.team.length > 0
          ? config.team.map((m) => `- ${m.id} (${m.role})`).join("\n")
          : "(no team members — you may complete this goal yourself)";

      parts.push(`# Goal\n${config.goal}`);
      parts.push(`\n# Your Role as Manager
You coordinate the team to achieve this goal by breaking it down into tasks and delegating to team members.

## Workflow
1. Break the goal down into specific, actionable tasks
2. Assign tasks to team members using \`assign_task\`
3. After assigning initial work, call \`wait_for_task_completions\` to pause until those tasks complete
4. Review results and assign follow-up tasks if needed
5. When the goal is fully achieved, call \`task_complete\` with a comprehensive summary

## Your Team
${teamList}

Begin by analyzing the goal and assigning tasks to your team.`);

      return parts.join("\n");
    }

    // Worker first-time startup: include task brief + standard worker instructions
    if (!isManager && agentState.conversationHistory.length === 0) {
      const task = agentState.currentTask
        ? state.tasks.find((t) => t.id === agentState.currentTask)
        : undefined;

      if (task) {
        parts.push(
          `# Your Assignment\nYou are ${agentId}, a ${agentState.role}.`,
        );
        parts.push(
          `\n## Task: ${task.title}\nTask ID: ${task.id}\n\n${task.brief}`,
        );
        parts.push(
          `\nWhen you complete your task, call \`task_complete\` with a summary of what you accomplished.\nIf you need clarification or help, use the \`ask\` tool.`,
        );
      }

      // Include any unread messages (e.g. task notification)
      const unreadMessages = state.messages.filter(
        (m) => m.to === agentId && m.status === "pending",
      );
      if (unreadMessages.length > 0) {
        parts.push(`\n# Pending Messages`);
        for (const msg of unreadMessages) {
          parts.push(`\nFrom ${msg.from}:`);
          if (msg.type === "ask") {
            parts.push(`\n**Question:** ${msg.content}\n`);
          } else {
            parts.push(`\n${msg.content}\n`);
          }
        }
      }

      return parts.length > 0 ? parts.join("\n") : undefined;
    }

    // Re-activation: include pending messages only (agent already has context)
    const unreadMessages = state.messages.filter(
      (m) => m.to === agentId && m.status === "pending",
    );

    if (unreadMessages.length > 0) {
      parts.push(`# Pending Messages`);
      for (const msg of unreadMessages) {
        parts.push(`\nFrom ${msg.from}:`);
        if (msg.type === "ask") {
          parts.push(`\n**Question:** ${msg.content}\n`);
        } else {
          parts.push(`\n${msg.content}\n`);
        }
      }
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  /**
   * Handle task completion
   */
  async function handleTaskCompletion(
    agentId: string,
    finalOutput: string,
  ): Promise<void> {
    const agentState = state.agentStates.get(agentId);
    if (!agentState) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Special case: manager completing their task = goal complete
    if (agentId === config.manager.id) {
      state.goalComplete = true;
      state.goalSummary = finalOutput;
      await config.callbacks?.onGoalComplete?.(finalOutput);
      logger.info(`Goal completed by manager: ${finalOutput}`);
      return;
    }

    // Regular task completion
    const task = state.tasks.find((t) => t.id === agentState.currentTask);
    if (!task) {
      // Agent had no current task (e.g., was run to respond to messages).
      // Treat as a graceful session end rather than an error.
      logger.info(
        `Agent ${agentId} called task_complete with no active task (likely finished responding to messages)`,
      );
      agentState.status = "idle";
      return;
    }

    // Update task
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.completionSummary = finalOutput;
    await config.callbacks?.onTaskCompleted?.(task);

    logger.info(`Task ${task.id} completed by ${agentId}`);

    // Clear agent's current task
    agentState.currentTask = undefined;
    agentState.status = "idle";

    // Notify task creator
    const notificationId = config.generateMessageId
      ? config.generateMessageId(state.messages)
      : generateMessageId(state.messages);
    const notification: TeamMessage = {
      id: notificationId,
      from: agentId,
      to: task.createdBy,
      type: "tell",
      content: `Task ${task.id} "${task.title}" completed:\n\n${task.completionSummary}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    state.messages.push(notification);
    await config.callbacks?.onMessageSent?.(notification);

    // Check for queued tasks for this agent
    const queuedTask = state.tasks.find(
      (t) => t.assignee === agentId && t.status === "queued",
    );

    if (queuedTask) {
      queuedTask.status = "active";
      agentState.currentTask = queuedTask.id;
      agentState.status = "working";

      // Inject new task context into the agent's conversation so they know about it
      agentState.conversationHistory.push({
        role: "user",
        content: `You have a new task assignment.\n\n# New Task: ${queuedTask.title}\nTask ID: ${queuedTask.id}\n\n${queuedTask.brief}\n\nPlease work on this task and call task_complete when done.`,
      });

      await config.callbacks?.onTaskActivated?.(queuedTask);
      logger.info(`Task ${queuedTask.id} activated for ${agentId}`);
    }
  }

  /**
   * Handle agent suspension
   */
  async function handleAgentSuspension(
    agentId: string,
    messageId: string,
  ): Promise<void> {
    const agentState = state.agentStates.get(agentId);
    if (!agentState) {
      throw new Error(`Agent ${agentId} not found`);
    }

    agentState.status = "blocked";
    agentState.blockedOn = messageId;

    await config.callbacks?.onAgentBlocked?.(agentId, messageId);
    logger.info(`Agent ${agentId} blocked waiting for message ${messageId}`);
  }

  // Internal helper functions for run loop
  let shouldStop = false;
  let stopResolver: ((state: AgentTeamState) => void) | undefined = undefined;
  const activeAgentSessions: Set<AgentSession> = new Set(); // Track all active agent sessions

  function getBlockedAgents(): Array<{ agentId: string; messageId: string }> {
    const blocked: Array<{ agentId: string; messageId: string }> = [];
    for (const [agentId, agentState] of state.agentStates) {
      if (agentState.status === "blocked" && agentState.blockedOn) {
        blocked.push({
          agentId,
          messageId: agentState.blockedOn,
        });
      }
    }
    return blocked;
  }

  function getNextWork(): WorkItem[] {
    const workItems: WorkItem[] = [];
    for (const [agentId, agentState] of state.agentStates) {
      if (agentState.status === "blocked" || !agentState.currentTask) {
        continue;
      }
      const task = state.tasks.find((t) => t.id === agentState.currentTask);
      if (task && task.status === "active") {
        workItems.push({
          agentId,
          taskId: task.id,
          task,
        });
      }
    }
    return workItems;
  }

  /**
   * Get agents that are idle but have pending messages they need to respond to.
   */
  function getAgentsWithPendingMessages(): string[] {
    const agents: string[] = [];
    for (const [agentId, agentState] of state.agentStates) {
      if (agentState.status === "blocked") continue;
      const hasPending = state.messages.some(
        (m) => m.to === agentId && m.status === "pending",
      );
      if (hasPending) {
        agents.push(agentId);
      }
    }
    return agents;
  }

  // The AgentTeam interface implementation
  const team: AgentTeam = {
    teamId: config.teamId,

    async run(): Promise<{
      complete: boolean;
      blockedAgents: Array<{ agentId: string; messageId: string }>;
      iterations: number;
    }> {
      shouldStop = false;
      const maxIterations = 100;
      let iterations = 0;

      logger.info(`Starting autonomous team run for goal: ${config.goal}`);

      // Start with the manager
      logger.info("Running manager to assign work...");
      await runAgent(config.manager.id);

      // Main loop
      while (iterations < maxIterations && !state.goalComplete && !shouldStop) {
        iterations++;
        logger.info(`\n=== Iteration ${iterations} ===`);

        // Check for blocked agents (waiting for external input)
        const blocked = getBlockedAgents();
        if (blocked.length > 0) {
          const externalBlocked = blocked.filter((b) => {
            const msg = state.messages.find((m) => m.id === b.messageId);
            return (
              msg && (msg.to === "BigBoss" || !state.agentStates.has(msg.to))
            );
          });

          if (externalBlocked.length > 0) {
            logger.info(
              `Agents blocked on external input: ${externalBlocked.map((b) => b.agentId).join(", ")}`,
            );
            return {
              complete: false,
              blockedAgents: externalBlocked,
              iterations,
            };
          }
        }

        // Get work items for team members
        const workItems = getNextWork();

        // If no work items but there are internally blocked agents,
        // check if any idle agents have pending messages they need to respond to
        if (workItems.length === 0 && blocked.length > 0) {
          const agentsWithMessages = getAgentsWithPendingMessages();
          if (agentsWithMessages.length > 0) {
            for (const responderId of agentsWithMessages) {
              if (shouldStop) break;
              logger.info(
                `Running ${responderId} to respond to pending messages...`,
              );
              await runAgent(responderId);
            }
            continue; // Re-evaluate loop state after running responders
          } else {
            // All blocked agents are internal, no one can respond - stuck
            logger.info(
              "No work and agents internally blocked with no responders - ending run",
            );
            break;
          }
        }

        if (workItems.length === 0 && blocked.length === 0) {
          // No work and no blocked agents - check if manager needs to run
          const managerState = state.agentStates.get(config.manager.id);
          if (managerState && managerState.status !== "blocked") {
            logger.info("No work items, running manager to check status...");
            const managerResult = await runAgent(config.manager.id);

            if (managerResult.completionReason === "task_complete") {
              // Manager completed the goal
              break;
            }

            // If manager still found no work, we might be stuck
            const workItemsAfter = getNextWork();
            if (
              workItemsAfter.length === 0 &&
              getBlockedAgents().length === 0
            ) {
              logger.info("No work and no blocked agents - ending run");
              break;
            }
          } else {
            logger.info("No work and manager is blocked - ending run");
            break;
          }
        }

        // Run all agents with work
        for (const work of workItems) {
          if (shouldStop) break;
          logger.info(`Running ${work.agentId} on task ${work.taskId}...`);
          await runAgent(work.agentId);

          // Check if goal completed
          if (state.goalComplete) {
            break;
          }
        }

        // After agents complete tasks, run manager to process notifications
        if (!state.goalComplete && !shouldStop) {
          const managerState = state.agentStates.get(config.manager.id);
          if (managerState && managerState.status !== "blocked") {
            logger.info("Running manager to process completions...");
            await runAgent(config.manager.id);
          }
        }
      }

      if (shouldStop) {
        logger.info("Team run stopped by user");
        if (stopResolver) {
          const resolver = stopResolver;
          stopResolver = undefined;
          resolver(state);
        }
      } else if (iterations >= maxIterations) {
        logger.info(`Reached max iterations (${maxIterations})`);
      }

      logger.info(
        `Team run complete. Goal complete: ${state.goalComplete}, Iterations: ${iterations}`,
      );

      return {
        complete: state.goalComplete,
        blockedAgents: getBlockedAgents(),
        iterations,
      };
    },

    async stop(): Promise<AgentTeamState> {
      logger.info("Stop requested");
      shouldStop = true;
      await Promise.all(
        [...activeAgentSessions].map((session) => session.stop()),
      );
      return state;
    },

    deliverMessageReply(messageId: string, replyContent: string): void {
      // Find the original message
      const originalMessage = state.messages.find((m) => m.id === messageId);
      if (!originalMessage || originalMessage.type !== "ask") {
        logger.error(
          `Cannot deliver reply - message ${messageId} not found or not an ask`,
        );
        return;
      }

      // Create reply message
      const replyId = config.generateMessageId
        ? config.generateMessageId(state.messages)
        : generateMessageId(state.messages);
      const reply: TeamMessage = {
        id: replyId,
        from: originalMessage.to,
        to: originalMessage.from,
        type: "tell",
        content: replyContent,
        status: "delivered",
        inReplyTo: messageId,
        createdAt: new Date().toISOString(),
      };

      state.messages.push(reply);
      originalMessage.status = "delivered";

      // Find the blocked agent and unblock them
      const blockedAgentId = originalMessage.from;
      const agentState = state.agentStates.get(blockedAgentId);

      if (agentState && agentState.blockedOn === messageId) {
        agentState.status = agentState.currentTask ? "working" : "idle";
        agentState.blockedOn = undefined;

        // Add the reply to their conversation history
        agentState.conversationHistory.push({
          role: "user",
          content: `Reply to your question from ${reply.from}:\n\n${replyContent}`,
        });

        config.callbacks?.onAgentUnblocked?.(blockedAgentId);
        config.callbacks?.onMessageSent?.(reply);
        config.callbacks?.onMessageDelivered?.(originalMessage);

        logger.info(
          `Agent ${blockedAgentId} unblocked with reply to ${messageId}`,
        );
      }
    },
  };

  // Internal function to run an agent
  async function runAgent(agentId: string): Promise<AgentRunResult> {
    const agentState = state.agentStates.get(agentId);
    if (!agentState) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Find agent config
    const isManager = agentId === config.manager.id;
    const agentConfig = isManager
      ? config.manager
      : config.team.find((m) => m.id === agentId);

    if (!agentConfig) {
      throw new Error(`Agent configuration not found for ${agentId}`);
    }

    // Build coordination tools
    const coordinationTools = createCoordinationTools(agentId);

    // Merge with domain tools
    const allTools = {
      ...coordinationTools,
      ...(agentConfig.tools || {}),
    };

    // For agents with existing history, inject any pending messages into their conversation
    // (buildInitialMessage handles the fresh-start case including pending messages)
    if (agentState.conversationHistory.length > 0) {
      const pendingMessages = state.messages.filter(
        (m) => m.to === agentId && m.status === "pending",
      );

      if (pendingMessages.length > 0) {
        const parts: string[] = ["# Pending Messages"];
        for (const msg of pendingMessages) {
          if (msg.type === "ask") {
            parts.push(
              `\nFrom ${msg.from} (message ${msg.id}):\n**Question:** ${msg.content}\nPlease reply using the tell tool with to="${msg.from}" and inReplyTo="${msg.id}".`,
            );
          } else {
            parts.push(`\nFrom ${msg.from}:\n${msg.content}`);
          }
          msg.status = "delivered";
          config.callbacks?.onMessageDelivered?.(msg);
        }

        // For the manager, add task status context so it knows what action to take next
        if (agentId === config.manager.id) {
          const incompleteTasks = state.tasks.filter(
            (t) => t.status === "active" || t.status === "queued",
          );
          const completedTasks = state.tasks.filter(
            (t) => t.status === "completed",
          );

          if (incompleteTasks.length > 0) {
            parts.push(`\n## Current Task Status`);
            parts.push(
              `Completed: ${completedTasks.length}, Remaining: ${incompleteTasks.length}`,
            );
            parts.push(
              `Remaining: ${incompleteTasks.map((t) => `${t.id} "${t.title}" (${t.status})`).join(", ")}`,
            );
            parts.push(
              `\nYou MUST call wait_for_task_completions now to continue waiting for the remaining tasks.`,
            );
          } else if (completedTasks.length > 0) {
            parts.push(`\n## All Tasks Complete`);
            parts.push(`All ${completedTasks.length} tasks are finished.`);
            parts.push(
              `\nReview the results above and call task_complete with a summary to finalize the goal.`,
            );
          }
        }

        agentState.conversationHistory.push({
          role: "user",
          content: parts.join("\n"),
        } as LoopMessage);
      }
    }

    // Build initial message for fresh sessions (includes goal/task context + standard instructions)
    const initialMessage =
      agentState.conversationHistory.length === 0
        ? buildInitialMessage(agentId)
        : undefined;

    logger.info(`Running agent ${agentId}...`);

    try {
      // Get any extra session callbacks from the factory (e.g. transcript management)
      const extraCallbacks: SessionCallbacks = config.sessionCallbacksFactory
        ? await config.sessionCallbacksFactory(agentId)
        : {};

      // Run the agent session (returns AgentSession which is awaitable)
      const session = runAgentSession(config.modelConfig, {
        sessionId: agentId,
        systemPrompt:
          agentConfig.systemPrompt || buildDefaultSystemPrompt(agentId),
        tools: allTools as any,
        messages: agentState.conversationHistory,
        initialMessage,
        maxTurns: config.maxTurnsPerSession,
        tokenLimit: config.tokenLimit,
        logger,
        callbacks: {
          // Pass through all extra callbacks (transcript updates, etc.)
          ...extraCallbacks,
          // Internal callbacks that also call through to extra callbacks
          onSuspend: async (sessionId: string, info: SessionSuspendInfo) => {
            const messageId = info.data?.messageId;
            if (messageId) {
              await handleAgentSuspension(agentId, messageId);
            }
            await extraCallbacks.onSuspend?.(sessionId, info);
          },
          onMessagesUpdate: async (sessionId: string, messages: Message[]) => {
            // Update agent's conversation history
            agentState.conversationHistory = messages;
            await extraCallbacks.onMessagesUpdate?.(sessionId, messages);
          },
        },
      });

      // Track this session
      activeAgentSessions.add(session);

      const result = await session;

      // Remove from active sessions
      activeAgentSessions.delete(session);

      // Update conversation history
      agentState.conversationHistory = result.messages;

      // Handle different completion reasons
      if (result.completionReason === "suspended") {
        return {
          agentId,
          suspended: true,
          suspendInfo: result.suspendInfo,
          finalOutput: result.finalOutput,
          completionReason: "suspended",
        };
      }

      if (result.completionReason === "task_complete") {
        await handleTaskCompletion(agentId, result.finalOutput);
        return {
          agentId,
          completed: true,
          finalOutput: result.finalOutput,
          completionReason: "task_complete",
        };
      }

      // Other completion reasons (max_turns, error)
      return {
        agentId,
        finalOutput: result.finalOutput,
        completionReason: result.completionReason,
      };
    } catch (error) {
      logger.error(`Error running agent ${agentId}:`, error);
      return {
        agentId,
        finalOutput: "",
        completionReason: "error",
        error: error as Error,
      };
    }
  }

  return team;
}
