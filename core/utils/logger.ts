const PURPLE = '\x1b[35m';
const RESET = '\x1b[0m';

const getPid = (): number => {
  return Deno.pid;
};

const isDebug = (): boolean => {
  return Deno.env.get('HOUND_DEBUG') === 'TRUE';
};

export const debug = (...args: unknown[]): void => {
  if (!isDebug()) return;
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  const pid = getPid();
  console.debug(
    `${PURPLE}[${ts}][${pid}]${RESET}`,
    ...args,
  );
};

export default { debug };
