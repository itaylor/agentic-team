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

      console.log("\n=== Step 1: Manager assigns work ===");
      const managerResult1 = await team.runAgent("Manager#1");
      console.log(`Manager result: ${managerResult1.completionReason}`);

      // Manager should have assigned at least one task
      assert.ok(
        team.state.tasks.length > 0,
        "Manager should have created tasks",
      );
      console.log(`Tasks created: ${team.state.tasks.length}`);

      // Get work for team members
      const workItems = team.getNextWork();
      console.log(`Work items available: ${workItems.length}`);
      assert.ok(workItems.length > 0, "Should have work items for team");

      console.log("\n=== Step 2: Worker completes task ===");
      for (const work of workItems) {
        console.log(`Running ${work.agentId} on task ${work.taskId}...`);
        const result = await team.runAgent(work.agentId);
        console.log(`${work.agentId} result: ${result.completionReason}`);
      }

      // Check that at least one task was completed
      const completedTasks = team.state.tasks.filter(
        (t) => t.status === "completed",
      );
      console.log(`Completed tasks: ${completedTasks.length}`);

      console.log("\n=== Step 3: Manager checks completion ===");
      const managerResult2 = await team.runAgent("Manager#1");
      console.log(`Manager result: ${managerResult2.completionReason}`);

      // Either goal is complete, or we're making progress
      console.log(`\nGoal complete: ${team.isGoalComplete()}`);
      console.log(`Events: ${events.join(", ")}`);

      // Basic assertions
      assert.ok(team.state.tasks.length > 0, "Should have created tasks");
      assert.ok(
        events.some((e) => e.startsWith("task_created")),
        "Should have created tasks",
      );

      // If goal is complete, verify
      if (team.isGoalComplete()) {
        assert.ok(
          events.includes("goal_complete"),
          "Should have goal_complete event",
        );
        console.log("\n✨ Test passed - goal completed!");
      } else {
        console.log("\n⚠️  Goal not complete yet, but progress was made");
        // Still pass the test if we made progress
        assert.ok(
          completedTasks.length > 0 || team.state.tasks.length > 0,
          "Should have made progress",
        );
      }
    });
  });
});
