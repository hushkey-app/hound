import { defineJob } from '@hushkey/remq';

export const byeWorldJob = defineJob(
  'bye-world',
  async (ctx) => {
    console.log(
      '%c- runs every 2 minutes',
      'color: white; background-color: blue;',
    );
  },
  {
    repeat: {
      pattern: '*/2 * * * *',
    },
    queue: 'testing',
    // attempts: 3,
  },
);
