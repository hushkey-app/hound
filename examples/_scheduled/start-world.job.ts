import { defineJob } from '@hushkey/hound/mod.ts';

export const startWorldJob = defineJob<{ foo: string }, { email: string }>(
  'start-world',
  async (ctx) => {
    ctx.data;
    ctx.foo;
    console.log(
      '%c- runs every 1 minute',
      'color: white; background-color: red;',
    );

    // for (let i = 0; i < 10_000; i++) {
    //   ctx.emit('user.read', {
    //     email: 'john.doe@example.com',
    //   }, { id: `on-request-${i + 1}`, queue: 'tasks' });
    // }
  },
  {
    repeat: {
      pattern: '* * * * *', // every 1 minute
    },
    queue: 'scheduled',
    // attempts: 3,
  },
);
