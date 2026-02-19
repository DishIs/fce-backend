import { Request, Response } from 'express';
import ratelimit from './ratelimit';

export const DOMAINS = [
    'ditapi.info',
    'ditcloud.info',
    'ditdrive.info',
    'ditgame.info',
    'ditlearn.info',
    'ditpay.info',
    'ditplay.info',
    'ditube.info',
    'junkstopper.info',
    'areureally.info',
];

export async function domainsHandler(req: Request, res: Response): Promise<void> {
    const ip = req.ip; // Get the client's IP address
    await ratelimit(ip); // Rate limiting
    console.log(`Client ${ip} requesting stats`);

    res.status(200).json({
        success: true,
        data: DOMAINS,
    });
}