import { hound, management } from './hound.plugin.ts';
import { requestJob } from './benchmarks/request.job.ts';
import { startWorldJob } from './_scheduled/start-world.ts';
import { midWorldJob } from './_scheduled/mid-world.ts';
import { endWorldJob } from './_scheduled/end-world.ts';
// import { userReadJob } from './_tasks/user.read.job.ts';
// import sqlite from 'node:sqlite'
hound.on(requestJob);
hound.on(startWorldJob);
hound.on(midWorldJob);
hound.on(endWorldJob);

// hound.on(userReadJob);

await hound.start();
