import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || 'localhost:6379';

console.log(REDIS_HOST)

const client = createClient({
  url: `redis://${REDIS_HOST}`,
});

const subscriber = createClient({
  url: `redis://${REDIS_HOST}`
});

client.on('error', (err) => console.log('Redis Client Error', err));
subscriber.on('error', (err) => console.log('Redis Subscriber Error', err));

(async () => {
  await client.connect();
  await subscriber.connect();
})();

export { client, subscriber };
