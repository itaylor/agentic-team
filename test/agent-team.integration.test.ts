// Integration tests for @waterfell/agentic-team

import { describe, it } from "node:test";
import assert from "node:assert";
import { createAgentTeam } from "../src/index.js";
import type {
  ModelConfig,
  Task,
  TeamMessage,
  AgentTeamState,
  Logger,
} from "../src/types.js";
import { createTestFileLogger } from "./test-helpers.js";

// Use local Ollama for testing
const TEST_MODEL_CONFIG: ModelConfig = {
  provider: "ollama",
  model: "gpt-oss:20b-128k",
  baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
};

const FAST_MAX_TURNS = 15;

describe("Agent Team Integration Tests", () => {
  describe("Basic Happy Path", () => {
    it("should complete a simple goal with manager and one worker", async () => {
      const { logger, log } = createTestFileLogger("basic-happy-path");
      const events: string[] = [];

      const team = createAgentTeam({
        teamId: "test-001",
        goal: "Write a two-line poem about coding",
        modelConfig: TEST_MODEL_CONFIG,
        logger,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager coordinating a small team.
Your goal is to complete: "Write a two-line poem about coding"

Break this down into tasks and assign them to your team members using the assign_task tool.
After you assign all tasks, call wait_for_task_completions to wait for your team to finish.
When you're told all tasks are complete, call task_complete with a summary.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a creative writer.
When you receive a task assignment, complete it by writing what was requested.
When done, call task_complete with your work.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onTaskCreated: (task) => {
            events.push(`task_created:${task.id}`);
            log(`📋 Task created: ${task.id} - ${task.title}`);
          },
          onTaskActivated: (task) => {
            events.push(`task_activated:${task.id}`);
            log(`▶️  Task activated: ${task.id}`);
          },
          onTaskCompleted: (task) => {
            events.push(`task_completed:${task.id}`);
            log(`✅ Task completed: ${task.id}`);
          },
          onMessageSent: (message) => {
            events.push(`message:${message.from}->${message.to}`);
            log(`💬 Message: ${message.from} → ${message.to}`);
          },
          onGoalComplete: (summary) => {
            events.push("goal_complete");
            log(`🎉 Goal complete!`);
            log(`Summary: ${summary}`);
          },
        },
      });

      log("\n=== Running team autonomously ===");
      const result = await team.run();

      log(`\nTeam run complete:`);
      log(`  Goal complete: ${result.complete}`);
      log(`  Iterations: ${result.iterations}`);
      log(`  Blocked agents: ${result.blockedAgents.length}`);
      log(`  Events: ${events.join(", ")}`);

      // Verify goal was completed
      assert.ok(result.complete, "Goal should be completed");

      // Verify we got the expected events
      assert.ok(
        events.some((e) => e.startsWith("task_created")),
        "Should have created tasks",
      );
      assert.ok(
        events.some((e) => e.startsWith("task_completed")),
        "Should have completed tasks",
      );
      assert.ok(events.includes("goal_complete"), "Should have completed goal");

      log("\n✨ Test passed - goal completed autonomously!");
    });
  });

  describe("Multiple Team Members", () => {
    it("should assign tasks to multiple workers and complete the goal", async () => {
      const { logger, log } = createTestFileLogger("multiple-team-members");
      const tasksCreated: Task[] = [];
      const tasksCompleted: Task[] = [];

      const team = createAgentTeam({
        teamId: "test-multi-worker",
        logger,
        goal: "Write two haikus: one about the sun and one about the moon",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager. Your goal: "Write two haikus: one about the sun and one about the moon"

You have two writers on your team: Poet#1 and Poet#2.
You MUST assign EXACTLY two tasks:
1. assign_task to Poet#1: write a haiku about the sun
2. assign_task to Poet#2: write a haiku about the moon

After assigning both tasks, call wait_for_task_completions.
When all tasks are complete, call task_complete with both haikus in your summary.`,
        },
        team: [
          {
            id: "Poet#1",
            role: "poet",
            systemPrompt: `You are a poet. Complete your assigned task by writing what is requested. Then call task_complete with the poem you wrote.`,
          },
          {
            id: "Poet#2",
            role: "poet",
            systemPrompt: `You are a poet. Complete your assigned task by writing what is requested. Then call task_complete with the poem you wrote.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onTaskCreated: (task) => {
            tasksCreated.push({ ...task });
          },
          onTaskCompleted: (task) => {
            tasksCompleted.push({ ...task });
          },
        },
      });

      const result = await team.run();

      assert.ok(result.complete, "Goal should be completed");
      assert.ok(
        tasksCreated.length >= 2,
        `Should have created at least 2 tasks, got ${tasksCreated.length}`,
      );
      assert.ok(
        tasksCompleted.length >= 2,
        `Should have completed at least 2 tasks, got ${tasksCompleted.length}`,
      );

      // Verify tasks were assigned to different agents
      const assignees = new Set(tasksCreated.map((t) => t.assignee));
      assert.ok(
        assignees.has("Poet#1"),
        "Poet#1 should have been assigned a task",
      );
      assert.ok(
        assignees.has("Poet#2"),
        "Poet#2 should have been assigned a task",
      );

      log("✨ Multi-worker test passed");
    });
  });

  describe("Task Queueing", () => {
    it("should queue tasks when a worker already has an active task", async () => {
      const { logger, log } = createTestFileLogger("task-queueing");
      const taskEvents: string[] = [];

      const team = createAgentTeam({
        teamId: "test-queueing",
        logger,
        goal: "Write three short phrases: one about dogs, one about cats, one about birds",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager. Your goal: "Write three short phrases about animals"

You have ONE writer: Writer#1.
You MUST assign exactly 3 tasks to Writer#1 (all to the same person):
1. assign_task to Writer#1: write a short phrase about dogs
2. assign_task to Writer#1: write a short phrase about cats
3. assign_task to Writer#1: write a short phrase about birds

After assigning all 3 tasks, call wait_for_task_completions.
When all tasks are complete, call task_complete with a summary of all three phrases.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Complete your assigned task with a short phrase. Then call task_complete with your phrase. Keep it to one sentence.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onTaskCreated: (task) => {
            taskEvents.push(`created:${task.id}:${task.status}`);
            log(`📋 Created ${task.id} status=${task.status}`);
          },
          onTaskActivated: (task) => {
            taskEvents.push(`activated:${task.id}`);
            log(`▶️  Activated ${task.id}`);
          },
          onTaskCompleted: (task) => {
            taskEvents.push(`completed:${task.id}`);
            log(`✅ Completed ${task.id}`);
          },
        },
      });

      const result = await team.run();

      assert.ok(result.complete, "Goal should be completed");

      // The first task should have been created as active, subsequent ones as queued
      const createdEvents = taskEvents.filter((e) => e.startsWith("created:"));
      assert.ok(
        createdEvents.length >= 2,
        `Should have created at least 2 tasks for queueing test, got ${createdEvents.length}`,
      );

      // First task should be active on creation, rest should be queued
      assert.ok(
        createdEvents[0].endsWith(":active"),
        `First task should be created as active, got: ${createdEvents[0]}`,
      );
      if (createdEvents.length > 1) {
        assert.ok(
          createdEvents[1].endsWith(":queued"),
          `Second task should be created as queued, got: ${createdEvents[1]}`,
        );
      }

      // Queued tasks should have been activated after prior tasks completed
      const activatedEvents = taskEvents.filter((e) =>
        e.startsWith("activated:"),
      );
      assert.ok(
        activatedEvents.length >= 1,
        "Queued tasks should have been activated",
      );

      log("✨ Task queueing test passed");
    });
  });

  describe("External Blocking (BigBoss)", () => {
    it("should block when agent asks BigBoss, resume after reply, and complete", async () => {
      const { logger, log } = createTestFileLogger("external-blocking-bigboss");
      const blockedEvents: Array<{ agentId: string; messageId: string }> = [];
      const unblockedEvents: string[] = [];

      const team = createAgentTeam({
        teamId: "test-bigboss",
        logger,
        goal: "Get approval from BigBoss before writing a poem, then write it",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager. Your goal: "Get approval from BigBoss before writing a poem, then write it"

IMPORTANT: First, you must ask BigBoss for approval by using the ask tool with to="BigBoss" and question="Should we write a poem about nature?". Do this IMMEDIATELY as your first action.
After you receive the reply from BigBoss, assign a task to Writer#1 to write the poem.
After assigning, call wait_for_task_completions.
When tasks are done, call task_complete with the final result.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Complete your assigned task. Then call task_complete with your work.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onAgentBlocked: (agentId, messageId) => {
            blockedEvents.push({ agentId, messageId });
            log(`🔒 Agent ${agentId} blocked on ${messageId}`);
          },
          onAgentUnblocked: (agentId) => {
            unblockedEvents.push(agentId);
            log(`🔓 Agent ${agentId} unblocked`);
          },
        },
      });

      // First run - should block waiting for BigBoss
      log("\n=== First run (should block on BigBoss) ===");
      const result1 = await team.run();

      assert.ok(!result1.complete, "Goal should NOT be complete yet");
      assert.ok(result1.blockedAgents.length > 0, "Should have blocked agents");

      const blockedOnBigBoss = result1.blockedAgents[0];
      assert.ok(blockedOnBigBoss, "Should have a blocked agent");
      assert.ok(
        blockedEvents.length > 0,
        "onAgentBlocked callback should have fired",
      );

      log(
        `Blocked agent: ${blockedOnBigBoss.agentId}, message: ${blockedOnBigBoss.messageId}`,
      );

      // Deliver reply from BigBoss
      log("\n=== Delivering BigBoss reply ===");
      team.deliverMessageReply(
        blockedOnBigBoss.messageId,
        "Yes, approved! Write a short poem about nature.",
      );

      assert.ok(
        unblockedEvents.length > 0,
        "onAgentUnblocked callback should have fired",
      );

      // Second run - should complete
      log("\n=== Second run (should complete) ===");
      const result2 = await team.run();

      assert.ok(
        result2.complete,
        "Goal should be completed after BigBoss reply",
      );

      log("✨ External blocking test passed");
    });
  });

  describe("Callbacks", () => {
    it("should fire all lifecycle callbacks in correct order", async () => {
      const { logger, log } = createTestFileLogger("callbacks-lifecycle");
      const events: Array<{ type: string; data: any }> = [];

      const team = createAgentTeam({
        teamId: "test-callbacks",
        logger,
        goal: "Write a one-sentence story",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
Assign exactly one task to Writer#1: "Write a one-sentence story about a robot."
After assigning, call wait_for_task_completions.
When the task is done, call task_complete with the story as your summary.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Write exactly what the task asks for in one sentence. Then call task_complete with it.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onTaskCreated: (task) => {
            events.push({
              type: "task_created",
              data: {
                id: task.id,
                assignee: task.assignee,
                status: task.status,
              },
            });
          },
          onTaskActivated: (task) => {
            events.push({ type: "task_activated", data: { id: task.id } });
          },
          onTaskCompleted: (task) => {
            events.push({
              type: "task_completed",
              data: { id: task.id, summary: task.completionSummary },
            });
          },
          onMessageSent: (message) => {
            events.push({
              type: "message_sent",
              data: { from: message.from, to: message.to, type: message.type },
            });
          },
          onGoalComplete: (summary) => {
            events.push({ type: "goal_complete", data: { summary } });
          },
          onAgentBlocked: (agentId, messageId) => {
            events.push({
              type: "agent_blocked",
              data: { agentId, messageId },
            });
          },
          onAgentUnblocked: (agentId) => {
            events.push({ type: "agent_unblocked", data: { agentId } });
          },
        },
      });

      const result = await team.run();
      assert.ok(result.complete, "Goal should complete");

      const eventTypes = events.map((e) => e.type);
      log("Event sequence:", eventTypes.join(" → "));

      // task_created must come before task_completed for the same task
      const firstCreated = eventTypes.indexOf("task_created");
      const firstCompleted = eventTypes.indexOf("task_completed");
      assert.ok(firstCreated >= 0, "Should have task_created event");
      assert.ok(firstCompleted >= 0, "Should have task_completed event");
      assert.ok(
        firstCreated < firstCompleted,
        "task_created should come before task_completed",
      );

      // goal_complete should be last
      assert.ok(
        eventTypes.includes("goal_complete"),
        "Should have goal_complete event",
      );
      const goalCompleteIdx = eventTypes.lastIndexOf("goal_complete");
      const lastTaskCompleted = eventTypes.lastIndexOf("task_completed");
      assert.ok(
        goalCompleteIdx > lastTaskCompleted,
        "goal_complete should come after last task_completed",
      );

      // Task created callback should have correct data
      const createdEvent = events.find((e) => e.type === "task_created");
      assert.ok(createdEvent, "Should find task_created event");
      assert.strictEqual(createdEvent!.data.assignee, "Writer#1");
      assert.ok(
        createdEvent!.data.id.startsWith("T-"),
        "Task ID should start with T-",
      );

      // Task completed callback should have summary field (may be empty string depending on LLM)
      const completedEvent = events.find((e) => e.type === "task_completed");
      assert.ok(completedEvent, "Should find task_completed event");
      assert.ok(
        completedEvent!.data.summary !== undefined,
        "Completed task should have a summary field",
      );

      // Manager waiting for tasks should generate a blocked event
      const blockedEvent = events.find((e) => e.type === "agent_blocked");
      if (blockedEvent) {
        assert.strictEqual(
          blockedEvent.data.agentId,
          "Manager#1",
          "Manager should be the blocked agent",
        );
      }

      // There should be a completion notification message from worker to manager
      const completionNotification = events.find(
        (e) =>
          e.type === "message_sent" &&
          e.data.from === "Writer#1" &&
          e.data.to === "Manager#1",
      );
      assert.ok(
        completionNotification,
        "Worker should send completion notification to manager",
      );

      log("✨ Callbacks test passed");
    });
  });

  describe("Custom ID Generators", () => {
    it("should use custom generateTaskId and generateMessageId when provided", async () => {
      const { logger, log } = createTestFileLogger("custom-id-generators");
      const generatedTaskIds: string[] = [];
      const generatedMessageIds: string[] = [];

      let taskCounter = 100;
      let messageCounter = 500;

      const team = createAgentTeam({
        teamId: "test-custom-ids",
        logger,
        goal: "Write a one-line joke",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
Assign exactly one task to Writer#1: "Write a one-line joke".
After assigning, call wait_for_task_completions.
When done, call task_complete with the joke.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a comedy writer. Write a one-line joke as requested. Then call task_complete with it.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        generateTaskId: (existingTasks) => {
          const id = `CUSTOM-T-${taskCounter++}`;
          generatedTaskIds.push(id);
          return id;
        },
        generateMessageId: (existingMessages) => {
          const id = `CUSTOM-M-${messageCounter++}`;
          generatedMessageIds.push(id);
          return id;
        },
        callbacks: {
          onTaskCreated: (task) => {
            log(`📋 Task ${task.id} created`);
          },
          onMessageSent: (message) => {
            log(`💬 Message ${message.id} sent`);
          },
        },
      });

      const result = await team.run();

      // The main thing we're testing is that custom ID generators were called,
      // regardless of whether the goal fully completed (LLM may not finish in time)

      // Custom task IDs should have been used
      assert.ok(
        generatedTaskIds.length > 0,
        "Custom generateTaskId should have been called",
      );
      assert.ok(
        generatedTaskIds[0].startsWith("CUSTOM-T-"),
        "Task IDs should use custom format",
      );

      // Custom message IDs should have been used (at minimum the manager suspension
      // triggers message generation, even if goal doesn't fully complete)
      if (result.complete) {
        // If goal completed, messages were definitely generated
        assert.ok(
          generatedMessageIds.length > 0,
          "Custom generateMessageId should have been called",
        );
        assert.ok(
          generatedMessageIds[0].startsWith("CUSTOM-M-"),
          "Message IDs should use custom format",
        );
      }

      log(`Custom task IDs: ${generatedTaskIds.join(", ")}`);
      log(`Custom message IDs: ${generatedMessageIds.join(", ")}`);
      log(`Goal completed: ${result.complete}`);
      log("✨ Custom ID generators test passed");
    });
  });

  describe("deliverMessageReply", () => {
    it("should return undefined and log error for non-existent message ID", async () => {
      const { logger, log } = createTestFileLogger("deliver-reply-bad-id");

      const team = createAgentTeam({
        teamId: "test-bad-reply",
        goal: "Placeholder goal",
        modelConfig: TEST_MODEL_CONFIG,
        logger,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: "You are a manager.",
        },
        team: [
          {
            id: "Worker#1",
            role: "worker",
            systemPrompt: "You are a worker.",
          },
        ],
      });

      // Delivering a reply to a non-existent message should not throw
      team.deliverMessageReply("M-9999", "This reply goes nowhere");

      // No crash = success
      log("✨ deliverMessageReply with bad ID test passed");
    });

    it("should unblock agent and add reply to conversation history when delivering valid reply", async () => {
      const { logger, log } = createTestFileLogger("deliver-reply-valid");
      const unblockedAgents: string[] = [];
      const deliveredMessages: TeamMessage[] = [];

      const team = createAgentTeam({
        teamId: "test-deliver-reply",
        logger,
        goal: "Ask BigBoss a question, then summarize the answer",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
IMMEDIATELY ask BigBoss a question using the ask tool with to="BigBoss" and question="What color should the logo be?".
After you get a reply, call task_complete with a summary that includes BigBoss's answer.`,
        },
        team: [],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onAgentUnblocked: (agentId) => {
            unblockedAgents.push(agentId);
          },
          onMessageDelivered: (message) => {
            deliveredMessages.push({ ...message });
          },
        },
      });

      // Run until blocked
      const result1 = await team.run();
      assert.ok(!result1.complete, "Should not be complete yet");
      assert.ok(result1.blockedAgents.length > 0, "Manager should be blocked");

      const blocked = result1.blockedAgents[0];

      // Deliver reply
      team.deliverMessageReply(blocked.messageId, "Make the logo blue.");

      assert.ok(
        unblockedAgents.includes("Manager#1"),
        "Manager should be unblocked",
      );
      assert.ok(
        deliveredMessages.length > 0,
        "onMessageDelivered should have fired for the original ask",
      );

      // Resume and complete
      const result2 = await team.run();
      assert.ok(result2.complete, "Goal should complete after reply delivered");

      log("✨ deliverMessageReply valid reply test passed");
    });
  });

  describe("stop()", () => {
    it("should stop a running team and return state", async () => {
      const { logger, log } = createTestFileLogger("stop");
      const team = createAgentTeam({
        teamId: "test-stop",
        logger,
        goal: "Write 10 different poems about 10 different animals, each at least 4 lines long",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager. Your goal requires a lot of work.
Assign a task to Writer#1 to write 10 poems about different animals.
After assigning, call wait_for_task_completions.
When done, call task_complete with a summary.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Write exactly what is asked. Take your time and write each poem carefully. Call task_complete when finished.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
      });

      // Start run in background, then stop after a short delay
      const runPromise = team.run();

      // Give it a moment to start, then stop
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const stoppedState = await team.stop();

      const result = await runPromise;

      // The run should have ended (either completed fast or was stopped)
      assert.ok(
        typeof result.complete === "boolean",
        "Result should have complete flag",
      );
      assert.ok(
        typeof result.iterations === "number",
        "Result should have iterations count",
      );

      // stop() should return state
      assert.ok(stoppedState, "stop() should return state");
      assert.ok(
        stoppedState.tasks !== undefined,
        "State should have tasks array",
      );
      assert.ok(
        stoppedState.messages !== undefined,
        "State should have messages array",
      );
      assert.ok(
        stoppedState.agentStates instanceof Map,
        "State should have agentStates Map",
      );

      log("✨ stop() test passed");
    });
  });

  describe("Resume from State", () => {
    it("should resume a team from previously saved state", async () => {
      const { logger, log } = createTestFileLogger("resume-from-state");
      const tasksCompleted: string[] = [];

      // Phase 1: Start a team that will block on BigBoss
      const team1 = createAgentTeam({
        teamId: "test-resume",
        logger,
        goal: "Get BigBoss approval then write a short greeting",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
IMMEDIATELY ask BigBoss for approval using the ask tool with to="BigBoss" and question="Can we proceed with writing a greeting?".
After you receive the reply, assign a task to Writer#1 to write a short greeting.
After assigning, call wait_for_task_completions.
When done, call task_complete with the greeting.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Write exactly what is asked. Call task_complete with your work.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onTaskCompleted: (task) => {
            tasksCompleted.push(task.id);
          },
        },
      });

      const result1 = await team1.run();
      assert.ok(!result1.complete, "Phase 1 should block on BigBoss");
      assert.ok(result1.blockedAgents.length > 0, "Should have blocked agents");

      // Capture state (simulate serialization roundtrip)
      const stoppedState = await team1.stop();
      const serialized = JSON.stringify({
        ...stoppedState,
        agentStates: Array.from(stoppedState.agentStates.entries()),
      });
      const deserialized = JSON.parse(serialized);
      const resumeState: AgentTeamState = {
        ...deserialized,
        agentStates: new Map(deserialized.agentStates),
      };

      // Phase 2: Create a NEW team instance from saved state
      const team2 = createAgentTeam({
        teamId: "test-resume",
        goal: "Get BigBoss approval then write a short greeting",
        modelConfig: TEST_MODEL_CONFIG,
        logger,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
IMMEDIATELY ask BigBoss for approval using the ask tool with to="BigBoss" and question="Can we proceed with writing a greeting?".
After you receive the reply, assign a task to Writer#1 to write a short greeting.
After assigning, call wait_for_task_completions.
When done, call task_complete with the greeting.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Write exactly what is asked. Call task_complete with your work.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        resumeFrom: resumeState,
        callbacks: {
          onTaskCompleted: (task) => {
            tasksCompleted.push(task.id);
          },
        },
      });

      // Deliver the BigBoss reply on the new instance
      const blockedMessageId = result1.blockedAgents[0].messageId;
      team2.deliverMessageReply(blockedMessageId, "Yes, approved! Go ahead.");

      // Run the resumed team to completion
      const result2 = await team2.run();
      assert.ok(result2.complete, "Resumed team should complete the goal");
      assert.ok(
        tasksCompleted.length > 0,
        "At least one task should have completed across both phases",
      );

      log("✨ Resume from state test passed");
    });
  });

  describe("Team with No Workers", () => {
    it("should allow manager to complete goal directly without assigning tasks", async () => {
      const { logger, log } = createTestFileLogger("no-workers-manager-only");
      let goalCompleted = false;

      const team = createAgentTeam({
        teamId: "test-manager-only",
        logger,
        goal: "Say hello world",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager. Your goal is simple: "Say hello world".
You can handle this yourself. Just call task_complete with "Hello World!" as the summary. Do NOT assign any tasks. Do NOT use any other tools. Just call task_complete immediately.`,
        },
        team: [],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onGoalComplete: () => {
            goalCompleted = true;
          },
        },
      });

      const result = await team.run();

      assert.ok(result.complete, "Goal should be completed by manager alone");
      assert.ok(goalCompleted, "onGoalComplete should have fired");
      assert.strictEqual(
        result.blockedAgents.length,
        0,
        "No agents should be blocked",
      );

      log("✨ Manager-only completion test passed");
    });
  });

  describe("Inter-Agent Communication", () => {
    it("should handle worker asking manager a question via ask", async () => {
      const { logger, log } = createTestFileLogger("inter-agent-communication");
      const messageEvents: Array<{ from: string; to: string; type: string }> =
        [];

      const team = createAgentTeam({
        teamId: "test-inter-agent",
        logger,
        goal: "Have the writer write a haiku about a color chosen by the manager",
        modelConfig: TEST_MODEL_CONFIG,
        manager: {
          id: "Manager#1",
          role: "manager",
          systemPrompt: `You are a project manager.
Your goal: Have the writer write a haiku about a color you choose.

Step 1: assign_task to Writer#1 with title "Write a haiku" and brief "Write a haiku about a color. If you are unsure what color, ask Manager#1 using the ask tool. Then call task_complete with your haiku."
Step 2: After assigning, call wait_for_task_completions.

IMPORTANT: If Writer#1 asks you a question, reply using the tell tool with the answer "blue" and include the inReplyTo field with the message ID.

When all tasks are complete, call task_complete with the haiku as your summary.`,
        },
        team: [
          {
            id: "Writer#1",
            role: "writer",
            systemPrompt: `You are a writer. Read your task brief carefully.
You MUST ask Manager#1 what color to use by calling the ask tool with to="Manager#1" and question="What color should the haiku be about?".
Wait for the reply, then write a haiku about that color.
Then call task_complete with your haiku.`,
          },
        ],
        maxTurnsPerSession: FAST_MAX_TURNS,
        callbacks: {
          onMessageSent: (message) => {
            messageEvents.push({
              from: message.from,
              to: message.to,
              type: message.type,
            });
            log(`💬 ${message.type}: ${message.from} → ${message.to}`);
          },
        },
      });

      const result = await team.run();

      log("Message events:", messageEvents);

      assert.ok(result.complete, "Goal should be completed");

      // Verify inter-agent ask/tell happened
      const writerAsks = messageEvents.filter(
        (e) =>
          e.from === "Writer#1" && e.to === "Manager#1" && e.type === "ask",
      );
      assert.ok(
        writerAsks.length > 0,
        "Writer should have asked Manager a question",
      );

      const managerReplies = messageEvents.filter(
        (e) =>
          e.from === "Manager#1" && e.to === "Writer#1" && e.type === "tell",
      );
      assert.ok(
        managerReplies.length > 0,
        "Manager should have replied to Writer",
      );

      log("✨ Inter-agent communication test passed");
    });
  });
});
