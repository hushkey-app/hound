import { hound } from './plugins/hound.plugin.ts';

await hound.start();

hound.emit('user.read', {
  email: 'leo@gmail.com',
  name: 'lucio',
}, { id: 'user.read-1' });

hound.emit('user.read', {
  email: 'leo@gmail.com',
  name: 'lucio',
}, { id: 'user.read-2' });

await hound.emitBatch([
  { event: 'user.read', data: { email: 'a@gmail.com', name: 'alice' } },
  { event: 'user.read', data: { email: 'b@gmail.com', name: 'bob' } },
  { event: 'user.read', data: { email: 'c@gmail.com', name: 'carol' } },
]);
