import { client } from "./redis";

const RATELIMIT: number = parseInt(process.env.RATELIMIT || "10");
const LOCALHOSTS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

export default async function ratelimit(ip: string): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    // Skip rate limiting for localhost/internal calls
    if (LOCALHOSTS.includes(ip)) {
      console.log(`[ratelimit] Bypassed for ${ip}`);
      return resolve();
    }

    const key = `lambdalimit:${ip}`;
    try {
      const result = await client.hGetAll(key);
      console.log(`[ratelimit] Checking ${key}`);

      if (result && result.tokens) {
        let tokens = parseInt(result.tokens) - 1;

        if (tokens < 0) {
          const ttl = await client.ttl(key);
          if (ttl === -1) {
            await client.expire(key, 1); // Ensure key expires even if race condition
          }
          console.warn(`[ratelimit] ${ip} is rate limited.`);
          return reject("rate limited");
        } else {
          const ttl = await client.ttl(key);
          if (ttl === -1) {
            await client.expire(key, 60);
          }
          await client.hSet(key, "tokens", tokens.toString());
          console.log(`[ratelimit] ${ip} allowed. Tokens left: ${tokens}`);
          return resolve();
        }

      } else {
        // First request in the window
        await client.hSet(key, "tokens", (RATELIMIT - 1).toString());
        await client.expire(key, 60);
        console.log(`[ratelimit] ${ip} allowed (first time). Tokens left: ${RATELIMIT - 1}`);
        return resolve();
      }
    } catch (error) {
      console.error(`[ratelimit] Redis error:`, error);
      return reject(JSON.stringify(error));
    }
  });
}
