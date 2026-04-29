import { defineJob } from '@hushkey/hound/mod.ts';

export const midWorldJob = defineJob(
  'mid-world',
  async (ctx) => {
    console.log(
      '%c- runs every 2 minutes',
      'color: white; background-color: purple;',
    );
  },
  {
    repeat: {
      pattern: '*/2 * * * *', // every 2 minutes
    },
    queue: 'scheduled',
    // attempts: 3,
  },
);
