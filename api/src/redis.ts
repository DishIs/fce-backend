import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS;

const client = createClient({ url: `redis://${REDIS_URL}` });
const subscriber = createClient({ url: `redis://${REDIS_URL}` });

client.on('error', (err) => console.log('Redis Client Error', err));
subscriber.on('error', (err) => console.log('Redis Subscriber Error', err));

(async () => {
  await client.connect();
  await subscriber.connect();
})();

export { client, subscriber };
