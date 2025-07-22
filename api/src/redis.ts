import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST; // e.g., "localhost:6379"
const REDIS_PASS = process.env.REDIS_PASS;

const client = createClient({
  url: `redis://${REDIS_HOST}`,
  password: REDIS_PASS,
});

const subscriber = createClient({
  url: `redis://${REDIS_HOST}`,
  password: REDIS_PASS,
});

client.on('error', (err) => console.log('Redis Client Error', err));
subscriber.on('error', (err) => console.log('Redis Subscriber Error', err));

(async () => {
  await client.connect();
  await subscriber.connect();
})();

export { client, subscriber };
