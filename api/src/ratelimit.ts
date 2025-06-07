import {client} from "./redis";

const RATELIMIT: number = parseInt(process.env.RATELIMIT || "10");

export default async function ratelimit(ip: string): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    const key = `lambdalimit:${ip}`;
    try {
      const result = await client.hGetAll(key);
      console.log(`ratelimiting ${key}`);
      if (result && result.tokens) {
        let tokens = parseInt(result.tokens) - 1;
        if (tokens < 0) {
          // A race condition can lead to the key never expiring; check for that
          const ttl = await client.ttl(key);
          if (ttl === -1) {
            await client.expire(key, 1);
          }
          reject("rate limited");
        } else {
          const ttl = await client.ttl(key);
          if (ttl === -1) {
            await client.expire(key, 1);
          }
          await client.hSet(key, "tokens", tokens.toString());
          resolve();
        }
      } else {
        await client.hSet(key, "tokens", (RATELIMIT - 1).toString());
        await client.expire(key, 60);
        resolve();
      }
    } catch (error) {
      reject(JSON.stringify(error));
    }
  });
}
