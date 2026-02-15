// Simple example of using agentic-team to coordinate a small team

import { createAgentTeam } from "../dist/index.js";

async function main() {
  console.log("Creating agent team...");

  const team = createAgentTeam({
    teamId: "example-001",
    goal: "Write a simple README file for a new npm package called 'hello-world'",
    modelConfig: {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      apiKey: process.env.ANTHROPIC_API_KEY || "",
    },
    manager: {
      id: "Morgan#1",
      systemPrompt: `You are a project manager coordinating a small team.
Your goal is to break down work into clear tasks and assign them to your team members.
Be concise and direct. Assign tasks with clear objectives and deliverables.
When all tasks are complete, call task_complete with a summary.`,
    },
    team: [
      {
        id: "Taylor#1",
        role: "technical_writer",
        systemPrompt: `You are a technical writer.
Write clear, concise documentation.
When you receive a task, complete it and call task_complete with your work.`,
      },
    ],
    callbacks: {
      onTaskCreated: (task) => {
        console.log(`\n📋 Task created: ${task.id} - ${task.title}`);
        console.log(`   Assigned to: ${task.assignee}`);
      },
      onTaskCompleted: (task) => {
        console.log(`\n✅ Task completed: ${task.id}`);
        console.log(`   Summary: ${task.completionSummary?.substring(0, 100)}...`);
      },
      onMessageSent: (message) => {
        console.log(`\n💬 Message: ${message.from} → ${message.to}`);
        console.log(`   ${message.content.substring(0, 80)}...`);
      },
      onGoalComplete: (summary) => {
        console.log(`\n🎉 Goal complete!`);
        console.log(`   ${summary}`);
      },
    },
  });

  console.log("Starting manager...\n");

  // Run the manager to delegate work
  const managerResult = await team.runAgent("Morgan#1");
  console.log(`\nManager result: ${managerResult.completionReason}`);

  if (managerResult.completed) {
    console.log("Manager completed goal immediately!");
    return;
  }

  // Run team members on their assigned tasks
  let iterations = 0;
  const maxIterations = 10;

  while (!team.isGoalComplete() && iterations < maxIterations) {
    iterations++;
    console.log(`\n--- Iteration ${iterations} ---`);

    const workItems = team.getNextWork();
    console.log(`Work items: ${workItems.length}`);

    if (workItems.length === 0) {
      // Check for blocked agents
      const blocked = team.getBlockedAgents();
      if (blocked.length > 0) {
        console.log("Agents are blocked waiting for replies:", blocked);
        break;
      }
      console.log("No work items and no blocked agents - done!");
      break;
    }

    // Run each agent with work
    for (const work of workItems) {
      console.log(`\nRunning ${work.agentId} on task ${work.taskId}...`);
      const result = await team.runAgent(work.agentId);

      if (result.suspended) {
        console.log(`${work.agentId} is blocked:`, result.suspendInfo?.reason);
      } else if (result.completed) {
        console.log(`${work.agentId} completed their task!`);
      }
    }

    // Run manager again to process notifications and decide what's next
    if (!team.isGoalComplete()) {
      console.log("\nRunning manager to review progress...");
      const managerResult2 = await team.runAgent("Morgan#1");
      console.log(`Manager result: ${managerResult2.completionReason}`);
    }
  }

  if (team.isGoalComplete()) {
    console.log("\n🎉 All work complete!");
    console.log("Goal summary:", team.state.goalSummary);
  } else {
    console.log("\n⚠️ Reached max iterations or blocked");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
