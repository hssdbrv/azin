import { createClient } from "redis";

export const redis = createClient({ url: process.env.REDIS_URL });
export const redisPub = redis.duplicate();
export const redisSub = redis.duplicate();

redis.on("error", (err) => console.error("Redis Error", err));
redisPub.on("error", (err) => console.error("Redis Pub Error", err));
redisSub.on("error", (err) => console.error("Redis Sub Error", err));

await redis.connect();
await redisPub.connect();
await redisSub.connect();

