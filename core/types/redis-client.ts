/**
 * Redis Client Type
 *
 * This type is used to define the Redis client type
 */
export interface RedisConnection
  extends InstanceType<typeof import('ioredis').Redis> {
  expose?: number;
}
