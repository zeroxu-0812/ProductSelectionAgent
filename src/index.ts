/**
 * index.ts —— 阶段 0 冒烟: 最小 Mastra workflow（@mastra/core 1.67 API）
 * 验证: createRun → start(inputData) → step 执行 → 结果
 */
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const helloStep = createStep({
  id: "hello",
  description: "最小冒烟步骤",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ inputData }) => {
    return { message: `Hello ${inputData.name} — Mastra 编排层就绪` };
  },
});

const helloWorkflow = createWorkflow({
  id: "hello-smoke",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
})
  .then(helloStep)
  .commit();

async function main() {
  const run = await helloWorkflow.createRun();
  const result = await run.start({ inputData: { name: "选品 agent" } });
  console.log("SMOKE OK:", JSON.stringify(result.steps?.hello?.output ?? result.result));
}

main();
