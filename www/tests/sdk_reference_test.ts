import { assert } from "@std/assert";

Deno.test("Sdk reference matches current API", async () => {
  const docUrl = new URL("../docs/reference/sdk.md", import.meta.url);
  const content = await Deno.readTextFile(docUrl);

  const requiredSnippets = [
    "Sdk",
    "management",
    "CRUD and control",
    "new Sdk(db: RedisConnection)",
    "const queues = await sdk.getQueuesInfo()",
    "const failedTasks = await sdk.listTasks({",
    "await sdk.retryTask",
    "AdminJobData",
    "## Types",
    "ListJobsOptions",
    "queue is required",
    "TaskStats",
    "QueueInfo",
    "getTask(taskId: string, queue: string): Promise<AdminJobData | null>",
    "listTasks(options?: ListJobsOptions): Promise<AdminJobData[]>",
    "deleteTask(taskId: string, queue: string): Promise<void>",
    "getQueueStats(queue: string): Promise<TaskStats>",
    "getQueues(): Promise<string[]>",
    "getQueuesInfo(): Promise<QueueInfo[]>",
    "retryTask",
    "Remq.emit()",
    "only failed jobs can be retried",
  ];

  for (const snippet of requiredSnippets) {
    assert(
      content.includes(snippet),
      `Expected Sdk reference to include ${snippet}.`,
    );
  }
});
