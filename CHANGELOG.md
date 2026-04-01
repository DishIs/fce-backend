# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-01

### Added
- **AI-Native MCP Server (`mcp-server`)**: Released a premium Model Context Protocol server enabling AI agents (like Claude) to easily integrate. Includes high-value tools like `create_and_wait_for_otp`, `get_latest_email`, and `extract_otp`.
- **Wait API (Long Polling)**: Introduced `GET /v1/inboxes/:inbox/wait` endpoint to replace inefficient polling.
- **Automated Paddle Billing Integration**: Added internal one-click upgrade endpoints (`POST /billing/auto-charge-plan` and `POST /billing/auto-buy-credits`) leveraging existing `paddleCustomerId` and Paddle's `automatic` collection mode.
- **Yearly Pricing Support**: Added new `.env` configurations to support `$1,430` (Enterprise), `$470` (Growth), `$182` (Startup), and `$67` (Developer) yearly subscriptions natively.
- **Webhook Logging & Analytics**: Advanced telemetry added for webhook events, recording `eventType`, `status`, `targetUrl`, and `responseCode` to support developer dashboards.
- **Platform Telemetry API**: Added `GET /api/statistics/platform-stats` providing sub-millisecond aggregations of total API calls, distinct active API users, and total emails received.

### Changed
- **Rate Limit & Feature Gating UX**: Standardized all API rate-limiting (`429`) and feature gate block (`403`) responses to return structured, conversion-optimized upgrade hints (`{ upgrade_required: true, recommended_plan: 'growth', pricing_url: '...' }`).
- **Webhook Plan Requirement**: Upgraded webhook access requirement to **Growth & Enterprise** plans exclusively (previously Startup+).

### Security
- **Strict Rate-Limiting on Premium Access**: `MCP` endpoints correctly apply multiple request charges per usage (2x-5x) with dedicated `mcpLimits` protecting concurrent loads.
