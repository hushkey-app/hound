import { defineJob } from '@hushkey/hound/mod.ts';

export const endWorldJob = defineJob(
  'end-world',
  async (ctx) => {
    console.log(
      '%c- runs every 4 minutes',
      'color: white; background-color: blue;',
    );
  },
  {
    repeat: {
      pattern: '*/4 * * * *', // every 4 minutes
    },
    queue: 'scheduled',
    // attempts: 3,
  },
);
