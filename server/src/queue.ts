import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env';

export const redisForQueue = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export type AgentJob = { runId: string };
export const agentQueue = new Queue<AgentJob>('agent-runs', { connection: redisForQueue() });
