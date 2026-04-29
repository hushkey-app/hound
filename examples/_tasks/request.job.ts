import { defineJob } from '@hushkey/hound/mod.ts';

interface OnRequestData {
  name: string;
  email: string;
}

export const userReadJob = defineJob<Record<string, unknown>, OnRequestData>(
  'user.read',
  async (ctx) => {
    console.log(ctx.id);
  },
  { queue: 'tasks', concurrency: 1 },
);
