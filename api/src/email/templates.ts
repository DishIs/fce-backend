// api/src/email/templates.ts
// ─────────────────────────────────────────────────────────────────────────────
//  All transactional HTML email templates.
//  Two layout variants:
//    layout()    → standard FreeCustom.Email branding (app users)
//    devLayout() → "FreeCustom.Email  for developers" branding (API users)
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_LOGO = 'https://www.freecustom.email/favicon.ico';
const APP_URL    = process.env.APP_URL || 'https://www.freecustom.email';

// ── Shared primitives ─────────────────────────────────────────────────────────

function pill(text: string, color: string, bg: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${color};background:${bg};">${text}</span>`;
}

function statBox(value: string, label: string): string {
  return `<td style="text-align:center;padding:16px 20px;background:#f9f9f9;border-radius:6px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#111;">${value}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#888;">${label}</p>
  </td>`;
}

function ctaButton(url: string, text: string, style: 'dark' | 'outline' = 'dark'): string {
  if (style === 'outline') {
    return `<a href="${url}" style="display:inline-block;border:1.5px solid #111;color:#111;padding:10px 26px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">${text}</a>`;
  }
  return `<a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:11px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">${text}</a>`;
}

// ── App layout (standard branding) ───────────────────────────────────────────

function layout(content: string, whyReason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #f0f0f0;">
              <img src="${BRAND_LOGO}" width="24" height="24" alt="" style="vertical-align:middle;margin-right:8px;">
              <span style="font-size:14px;font-weight:600;color:#111;vertical-align:middle;">FreeCustom.Email</span>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">${content}</td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #f0f0f0;background:#fafafa;border-radius:0 0 8px 8px;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.6px;">Why am I receiving this?</p>
              <p style="margin:0;font-size:12px;color:#bbb;line-height:1.7;">
                ${whyReason} This email was sent by
                <a href="${APP_URL}" style="color:#bbb;text-decoration:underline;">FreeCustom.Email</a>.
                If you believe this is a mistake, reply and we'll sort it out.
              </p>
              <p style="margin:12px 0 0;font-size:12px;color:#ccc;">© 2026 FreeCustom.Email</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Developer API layout (dual-brand) ─────────────────────────────────────────

function devLayout(content: string, whyReason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">
          <!-- Developer header -->
          <tr>
            <td style="padding:28px 40px 22px;border-bottom:1px solid #f0f0f0;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${BRAND_LOGO}" width="22" height="22" alt="" style="vertical-align:middle;margin-right:8px;">
                  </td>
                  <td style="vertical-align:middle;line-height:1.1;">
                    <div style="font-size:14px;font-weight:600;color:#111;">FreeCustom.Email</div>
                    <div style="font-size:11px;color:#888;font-weight:400;letter-spacing:0.2px;">for developers</div>
                  </td>
                  <td style="padding-left:16px;vertical-align:middle;">
                    <span style="display:inline-block;padding:2px 8px;background:#f0f0f0;border-radius:4px;font-size:11px;font-weight:500;color:#666;font-family:monospace;">API</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">${content}</td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #f0f0f0;background:#fafafa;border-radius:0 0 8px 8px;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.6px;">Why am I receiving this?</p>
              <p style="margin:0;font-size:12px;color:#bbb;line-height:1.7;">
                ${whyReason} Sent from the
                <a href="${APP_URL}/api" style="color:#bbb;text-decoration:underline;">FreeCustom.Email Developer API</a>.
                Reply if you think this is a mistake.
              </p>
              <p style="margin:12px 0 0;font-size:12px;color:#ccc;">© 2026 FreeCustom.Email</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  APP PLAN TEMPLATES
// ═════════════════════════════════════════════════════════════════════════════

export interface CancellationEmailData {
  periodEnd:     string;
  emailCount:    number;
  storageUsedMB: number;
  inboxCount:    number;
}

export function getCancellationEmailHtml(data: CancellationEmailData): string {
  const { periodEnd, emailCount, storageUsedMB, inboxCount } = data;
  const endDate = new Date(periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const storageLabel = storageUsedMB >= 1024 ? `${(storageUsedMB / 1024).toFixed(1)} GB` : `${storageUsedMB.toFixed(0)} MB`;

  const lossItems = [
    'Your stored emails will be trimmed to the <strong>20 most recent</strong>',
    'Emails will expire after <strong>24 hours</strong> instead of being kept forever',
    'Custom domain email routing will stop working',
    'OTP and verification link detection will be hidden',
  ].map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#92400e;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#92400e;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">Your subscription has been cancelled</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      Your Pro access remains active until <strong style="color:#111;">${endDate}</strong>, 
      after which your account reverts to the free plan.
    </p>
    <div style="background:#fff8ed;border:1px solid #fde68a;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#92400e;">What changes on ${endDate}</p>
      <table width="100%" cellpadding="0" cellspacing="0">${lossItems}</table>
    </div>
    <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;">Your current usage</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statBox(emailCount.toLocaleString(), 'Emails stored')}
        <td width="8"></td>
        ${statBox(storageLabel, 'Storage used')}
        <td width="8"></td>
        ${statBox(String(inboxCount), inboxCount === 1 ? 'Inbox' : 'Inboxes')}
      </tr>
    </table>
    <p style="margin:28px 0 24px;font-size:14px;color:#444;line-height:1.6;">
      Changed your mind? Resubscribe before ${endDate} and keep everything exactly as it is.
    </p>
    ${ctaButton(`${APP_URL}/pricing`, 'Keep my Pro plan')}
    &nbsp;&nbsp;
    ${ctaButton(`${APP_URL}/dashboard`, 'Go to dashboard', 'outline')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      We'd love to know why you cancelled — just reply to this email.
    </p>`;

  return layout(content, "You're receiving this because you cancelled your Pro subscription on FreeCustom.Email.");
}

export function getDowngradeCompleteEmailHtml(): string {
  const freeFeatures = [
    'Unlimited inboxes (1 active at a time)',
    'Emails kept for 24 hours',
    'Instant email delivery',
    'QR code sharing',
  ].map(f => `<tr>
    <td style="padding:4px 0;font-size:13px;color:#444;vertical-align:top;width:18px;">✓</td>
    <td style="padding:4px 0;font-size:13px;color:#444;">${f}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">Your account has been downgraded</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      Your Pro subscription has ended and your account is now on the free plan.
      Your most recent 20 emails have been preserved.
    </p>
    <div style="background:#f9f9f9;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;">What you still get on the free plan</p>
      <table width="100%" cellpadding="0" cellspacing="0">${freeFeatures}</table>
    </div>
    ${ctaButton(`${APP_URL}/pricing`, 'Upgrade to Pro again')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">Questions? Just reply to this email.</p>`;

  return layout(content, "You're receiving this because your Pro subscription period ended and your account was downgraded to free.");
}

export function getDomainWarningEmailHtml(domain: string, txtOk: boolean, mxOk: boolean): string {
  const issues: string[] = [];
  if (!txtOk) issues.push('TXT verification record is missing or incorrect');
  if (!mxOk)  issues.push('MX record is not pointing to <code style="font-family:monospace;background:#f5f5f5;padding:1px 5px;border-radius:3px;font-size:12px;">mx.freecustom.email</code>');

  const issueRows = issues.map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#92400e;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#92400e;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">DNS issue detected</p>
    <p style="margin:0 0 20px;">${pill('Action required', '#92400e', '#fef3c7')}&nbsp;&nbsp;<span style="font-size:13px;color:#888;">Domain: <strong style="color:#111;">${domain}</strong></span></p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      We ran a routine DNS check on your custom domain and found a problem.
      <strong style="color:#111;">No action has been taken yet</strong> — your domain is still active.
      If the issue isn't resolved before our next check, the domain will be automatically de-verified.
    </p>
    <div style="background:#fff8ed;border:1px solid #fde68a;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#92400e;">Issues found</p>
      <table width="100%" cellpadding="0" cellspacing="0">${issueRows}</table>
    </div>
    ${ctaButton(`${APP_URL}/dashboard/domains`, 'Fix DNS settings →')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      DNS propagation can take up to 48 hours. Reply if you need help.
    </p>`;

  return layout(content, "You're receiving this because you have a verified custom domain on FreeCustom.Email and we run periodic DNS health checks.");
}

export function getDomainRevocationEmailHtml(domain: string, txtOk: boolean, mxOk: boolean): string {
  const issues: string[] = [];
  if (!txtOk) issues.push('TXT verification record was missing or incorrect');
  if (!mxOk)  issues.push('MX record was not pointing to <code style="font-family:monospace;background:#fef2f2;padding:1px 5px;border-radius:3px;font-size:12px;">mx.freecustom.email</code>');

  const issueRows = issues.map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#991b1b;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#991b1b;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">Custom domain de-verified</p>
    <p style="margin:0 0 20px;">${pill('Email delivery stopped', '#991b1b', '#fee2e2')}&nbsp;&nbsp;<span style="font-size:13px;color:#888;">Domain: <strong style="color:#111;">${domain}</strong></span></p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      After multiple failed DNS checks, <strong style="color:#111;">${domain}</strong> has been
      de-verified and will <strong style="color:#111;">no longer receive emails</strong> through FreeCustom.Email.
    </p>
    <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#991b1b;">DNS issues that caused this</p>
      <table width="100%" cellpadding="0" cellspacing="0">${issueRows}</table>
    </div>
    <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
      Once you've corrected your DNS records, re-verify your domain instantly from the dashboard.
    </p>
    ${ctaButton(`${APP_URL}/dashboard/domains`, 'Re-verify my domain →')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">Believe this is a mistake? Reply and we'll look into it.</p>`;

  return layout(content, "You're receiving this because you have a verified custom domain on FreeCustom.Email and we run periodic DNS health checks.");
}

// ── Account deletion (scheduled) ──────────────────────────────────────────────
export function getDeletionScheduledEmailHtml(scheduledDeletionAt: Date, appUrl: string): string {
  const dateStr = new Date(scheduledDeletionAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">Account scheduled for deletion</p>
    <p style="margin:0 0 20px;">${pill('Cooldown period', '#92400e', '#fef3c7')}&nbsp;&nbsp;<span style="font-size:13px;color:#888;">Permanent deletion: <strong style="color:#111;">${dateStr}</strong></span></p>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      We've removed your stored emails, attachments, and inbox addresses. Your account can still be <strong>restored</strong> until the date above.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
      After that date, your account will be permanently deleted and you will not be able to log in or restore it.
    </p>
    ${ctaButton(`${appUrl}/dashboard`, 'Restore my account →')}
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">If you did not request this, please restore your account and secure it.</p>`;
  return layout(content, "You requested account deletion on FreeCustom.Email. This email confirms the schedule and your option to restore.");
}

// ── Account deletion (permanent) ──────────────────────────────────────────────
export function getDeletionPermanentEmailHtml(): string {
  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">Account permanently deleted</p>
    <p style="margin:0 0 20px;">${pill('Done', '#166534', '#dcfce7')}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Your FreeCustom.Email account has been permanently deleted as requested. All account data has been removed.
    </p>
    <p style="margin:0 0 0;font-size:12px;color:#999;line-height:1.6;">You can sign up again later if you choose. Thank you for having used our service.</p>`;
  return layout(content, "You had requested account deletion on FreeCustom.Email. This confirms the process is complete.");
}

// ═════════════════════════════════════════════════════════════════════════════
//  DEVELOPER API TEMPLATES  (devLayout — "for developers" branding)
// ═════════════════════════════════════════════════════════════════════════════

// ── API Plan cancelled ────────────────────────────────────────────────────────

export function getApiPlanCancellationEmailHtml(plan: string, periodEnd: string): string {
  const endDate = new Date(periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  const lossItems = [
    'Rate limit drops to <strong>1 req/s · 5,000 req/month</strong>',
    'OTP extraction will be disabled',
    'WebSocket access will be revoked (if your plan included it)',
    'Your API inboxes remain registered (no data is deleted)',
    'Unused credits you\'ve purchased <strong>never expire</strong>',
  ].map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#92400e;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#92400e;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">API ${planLabel} plan cancelled</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      Your ${planLabel} plan access remains active until <strong style="color:#111;">${endDate}</strong>,
      after which your account reverts to the Free API tier.
    </p>
    <div style="background:#fff8ed;border:1px solid #fde68a;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#92400e;">What changes on ${endDate}</p>
      <table width="100%" cellpadding="0" cellspacing="0">${lossItems}</table>
    </div>
    <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
      Need more requests without a subscription? Credits never expire and work on the free tier too.
    </p>
    ${ctaButton(`${APP_URL}/api/pricing`, 'Resubscribe or buy credits')}
    &nbsp;&nbsp;
    ${ctaButton(`${APP_URL}/dashboard/api`, 'View API dashboard', 'outline')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      We'd love to know why you cancelled — just reply to this email.
    </p>`;

  return devLayout(content, "You're receiving this because you cancelled your API subscription on FreeCustom.Email.");
}

// ── API Plan downgraded (after grace period expires) ─────────────────────────

export function getApiPlanDowngradeEmailHtml(previousPlan: string): string {
  const planLabel = previousPlan.charAt(0).toUpperCase() + previousPlan.slice(1);

  const freeFeatures = [
    '5,000 requests / month',
    '1 request / second',
    'API inboxes remain registered',
    'Credits you\'ve purchased still work',
  ].map(f => `<tr>
    <td style="padding:4px 0;font-size:13px;color:#444;vertical-align:top;width:18px;">✓</td>
    <td style="padding:4px 0;font-size:13px;color:#444;">${f}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">API plan downgraded to Free</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      Your ${planLabel} API plan has ended. Your account is now on the Free tier.
    </p>
    <div style="background:#f9f9f9;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;">What you still get on the Free tier</p>
      <table width="100%" cellpadding="0" cellspacing="0">${freeFeatures}</table>
    </div>
    ${ctaButton(`${APP_URL}/api/pricing`, 'Upgrade again')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">Questions? Reply to this email.</p>`;

  return devLayout(content, "You're receiving this because your API subscription period ended.");
}

// ── Quota warning (80% threshold) ────────────────────────────────────────────

export interface QuotaWarningData {
  plan:               string;
  requestsUsed:       number;
  requestsLimit:      number;
  percentUsed:        number;
  creditsRemaining:   number;
  resetsAt:           string; // ISO date string
}

export function getApiQuotaWarningEmailHtml(data: QuotaWarningData): string {
  const {
    plan, requestsUsed, requestsLimit, percentUsed, creditsRemaining, resetsAt,
  } = data;

  const planLabel    = plan.charAt(0).toUpperCase() + plan.slice(1);
  const resetDate    = new Date(resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const remaining    = requestsLimit - requestsUsed;
  const urgencyColor = percentUsed >= 95 ? '#991b1b' : '#92400e';
  const urgencyBg    = percentUsed >= 95 ? '#fee2e2' : '#fff8ed';
  const urgencyBorder = percentUsed >= 95 ? '#fecaca' : '#fde68a';

  // Progress bar width
  const barWidth = Math.min(100, Math.round(percentUsed));
  const barColor = percentUsed >= 95 ? '#ef4444' : percentUsed >= 80 ? '#f59e0b' : '#22c55e';

  // Next plan upsell
  const nextPlanMap: Record<string, { name: string; rps: number; rpm: string; price: string }> = {
    free:       { name: 'Developer', rps: 10,  rpm: '100k',  price: '$7/mo'  },
    developer:  { name: 'Startup',   rps: 25,  rpm: '500k',  price: '$19/mo' },
    startup:    { name: 'Growth',    rps: 50,  rpm: '2M',    price: '$49/mo' },
    growth:     { name: 'Enterprise',rps: 100, rpm: '10M',   price: '$149/mo'},
    enterprise: { name: '',          rps: 0,   rpm: '',      price: ''       },
  };
  const next = nextPlanMap[plan.toLowerCase()];

  const upsellBlock = next?.name ? `
    <div style="background:#f9f9f9;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#111;">Upgrade to ${next.name} — ${next.price}</p>
      <p style="margin:0 0 12px;font-size:13px;color:#666;line-height:1.5;">
        Get <strong>${next.rpm} requests/month</strong> and <strong>${next.rps} req/s</strong>.
        Never worry about quotas again.
      </p>
      ${ctaButton(`${APP_URL}/api/pricing`, `Upgrade to ${next.name} →`)}
    </div>` : '';

  const creditsBlock = creditsRemaining > 0
    ? `<p style="margin:0 0 24px;font-size:13px;color:#666;line-height:1.5;">
        You have <strong style="color:#111;">${creditsRemaining.toLocaleString()} credits</strong> remaining — 
        these will be used automatically when your monthly quota runs out.
       </p>`
    : `<div style="background:#f9f9f9;border-radius:6px;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#111;">No credits remaining</p>
        <p style="margin:0 0 12px;font-size:13px;color:#666;">
          Buy credits (they never expire) to cover overages without changing your plan.
        </p>
        ${ctaButton(`${APP_URL}/api/credits`, 'Buy credits', 'outline')}
       </div>`;

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">You've used ${Math.round(percentUsed)}% of your monthly quota</p>
    <p style="margin:0 0 20px;">${pill(`${planLabel} plan`, '#374151', '#f3f4f6')}</p>

    <!-- Progress bar -->
    <div style="background:#f0f0f0;border-radius:4px;height:8px;margin-bottom:8px;overflow:hidden;">
      <div style="background:${barColor};width:${barWidth}%;height:8px;border-radius:4px;"></div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="font-size:12px;color:#888;">${requestsUsed.toLocaleString()} used</td>
        <td style="font-size:12px;color:#888;text-align:right;">${requestsLimit.toLocaleString()} limit</td>
      </tr>
    </table>

    <div style="background:${urgencyBg};border:1px solid ${urgencyBorder};border-radius:6px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:13px;color:${urgencyColor};line-height:1.5;">
        <strong>${remaining.toLocaleString()} requests remaining</strong> before your quota resets on <strong>${resetDate}</strong>.
        Once exhausted, requests will ${creditsRemaining > 0 ? 'draw from your credits' : 'be rejected with HTTP 429'}.
      </p>
    </div>

    ${creditsBlock}
    ${upsellBlock}

    ${ctaButton(`${APP_URL}/dashboard/api`, 'View usage dashboard', 'outline')}

    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      This is a one-time warning per billing period. You won't receive another until next month.
    </p>`;

  return devLayout(content, `You're receiving this because your API account (${planLabel} plan) has reached ${Math.round(percentUsed)}% of its monthly quota.`);
}

// ── Quota exhausted (100%) ────────────────────────────────────────────────────

export function getApiQuotaExhaustedEmailHtml(plan: string, resetsAt: string, creditsRemaining: number): string {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const resetDate = new Date(resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">Monthly quota exhausted</p>
    <p style="margin:0 0 20px;">${pill('Requests are being rejected', '#991b1b', '#fee2e2')}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Your ${planLabel} plan quota has been fully used this month.
      ${creditsRemaining > 0
        ? `You have <strong>${creditsRemaining.toLocaleString()} credits</strong> remaining — these are now absorbing requests automatically.`
        : `All requests are currently returning <code style="font-family:monospace;background:#f5f5f5;padding:1px 5px;border-radius:3px;">HTTP 429</code>. Your quota resets on <strong>${resetDate}</strong>.`
      }
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#444;font-weight:500;">
      The fastest fix:
    </p>
    ${ctaButton(`${APP_URL}/api/credits`, 'Buy credits (never expire)')}
    &nbsp;&nbsp;
    ${ctaButton(`${APP_URL}/api/pricing`, 'Upgrade plan', 'outline')}
    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      Questions? Reply to this email.
    </p>`;

  return devLayout(content, `You're receiving this because your ${planLabel} API plan quota was exhausted.`);
}