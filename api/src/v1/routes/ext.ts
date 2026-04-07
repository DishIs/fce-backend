import { Router } from 'express';
import { getSettingsHandler, updateSettingsHandler } from '../../services/user';
import { getDomainsHandler } from '../../services/user';
import { listHandler, messageHandler, deleteHandler } from '../../services/mailbox';
import { addInboxHandler } from '../../handlers/inbox-handler';
import { db } from '../../config/mongo';
import jwt from 'jsonwebtoken';

const extRouter = Router();

// Inherits apiKeyAuth and apiRateLimit from v1Router

// Get user inboxes
extRouter.get('/inboxes', async (req, res) => {
  if (!req.apiUser || req.apiUser.userId === 'anonymous') {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  
  try {
    const user = await db.collection('users').findOne({
      $or: [
        { wyiUserId: req.apiUser.userId },
        { linkedProviderIds: req.apiUser.userId },
      ],
    }, { projection: { inboxes: 1 } });
    
    const inboxes = user?.inboxes || [];
    return res.json({ success: true, data: inboxes });
  } catch (error) {
    console.error('Error fetching inboxes:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// WebSocket ticket route
extRouter.get('/ws-ticket', (req, res) => {
  const mailbox = req.query.mailbox as string;
  if (!mailbox) return res.status(400).json({ error: 'Mailbox required' });

  try {
    const plan = req.apiUser?.plan || 'free';
    const userId = req.apiUser?.userId || 'anonymous';
    const secret = process.env.JWT_SECRET || 'fallback_dev_secret_only';

    // Sign a standard jsonwebtoken (jose not required here as we use jsonwebtoken everywhere else in backend)
    const token = jwt.sign(
      { mailbox, plan, sub: userId },
      secret,
      { expiresIn: '8h' }
    );

    return res.json({ success: true, token });
  } catch (error) {
    console.error('ws-ticket error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Register inbox route
extRouter.post('/register-inbox', (req, res, next) => {
  if (!req.apiUser || req.apiUser.userId === 'anonymous') {
    return res.status(401).json({ success: false, message: 'Authentication required to register inboxes' });
  }
  req.body.wyiUserId = req.apiUser.userId;
  return addInboxHandler(req, res);
});

extRouter.get('/mailbox/:name', listHandler);
extRouter.get('/mailbox/:name/message/:id', messageHandler);
extRouter.delete('/mailbox/:name/message/:id', deleteHandler);

// Re-use internal handlers, but adapt the request
extRouter.post('/settings', (req, res, next) => {
  if (req.apiUser) {
    req.body.wyiUserId = req.apiUser.userId;
  }
  return updateSettingsHandler(req, res);
});

extRouter.get('/settings', (req, res, next) => {
  if (req.apiUser) {
    req.body.wyiUserId = req.apiUser.userId;
  }
  return getSettingsHandler(req, res);
});

export default extRouter;
