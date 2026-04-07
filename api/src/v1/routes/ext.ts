import { Router } from 'express';
import { getSettingsHandler, updateSettingsHandler } from '../../services/user';
import { getDomainsHandler } from '../../services/user';

const extRouter = Router();

// Inherits apiKeyAuth and apiRateLimit from v1Router

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
