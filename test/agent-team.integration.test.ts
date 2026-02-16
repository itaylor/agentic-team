// Integration tests for @waterfell/agentic-team

import { describe, it } from "node:test";
import assert from "node:assert";
import { createAgentTeam } from "../src/index.js";
import type { ModelConfig } from "../src/types.js";

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
      const events: string[] = [];

      const team = createAgentTeam({
        teamId: "test-001",
        goal: "Write a two-line poem about coding",
        modelConfig: TEST_MODEL_CONFIG,
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
            console.log(`📋 Task created: ${task.id} - ${task.title}`);
          },
          onTaskActivated: (task) => {
            events.push(`task_activated:${task.id}`);
            console.log(`▶️  Task activated: ${task.id}`);
          },
          onTaskCompleted: (task) => {
            events.push(`task_completed:${task.id}`);
            console.log(`✅ Task completed: ${task.id}`);
          },
          onMessageSent: (message) => {
            events.push(`message:${message.from}->${message.to}`);
            console.log(`💬 Message: ${message.from} → ${message.to}`);
          },
          onGoalComplete: (summary) => {
            events.push("goal_complete");
            console.log(`🎉 Goal complete!`);
            console.log(`Summary: ${summary}`);
          },
        },
      });

      console.log("\n=== Running team autonomously ===");
      const result = await team.run();

      console.log(`\nTeam run complete:`);
      console.log(`  Goal complete: ${result.complete}`);
      console.log(`  Iterations: ${result.iterations}`);
      console.log(`  Blocked agents: ${result.blockedAgents.length}`);
      console.log(`  Events: ${events.join(", ")}`);

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

      console.log("\n✨ Test passed - goal completed autonomously!");
    });
  });
});
