# ResumeAI Pro 🚀

AI-powered resume builder SaaS. Built for solopreneurs targeting ₹1 lakh/month.

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env with your keys

# 3. Start the server
npm start
# → http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RAZORPAY_KEY_ID` | ✅ | Your Razorpay key ID |
| `RAZORPAY_KEY_SECRET` | ✅ | Your Razorpay secret |
| `ANTHROPIC_API_KEY` | ✅ | For AI resume generation |
| `SMTP_USER` | Optional | Gmail for sending emails |
| `SMTP_PASS` | Optional | Gmail app password |
| `SESSION_SECRET` | ✅ | Any random 64-char string |

## API Endpoints

```
POST /api/auth/register       — Create account
POST /api/auth/login          — Login by email
GET  /api/auth/me             — Get current user

POST /api/payment/create-order — Create Razorpay order
POST /api/payment/verify       — Verify payment signature

POST /api/resume/generate      — AI resume generation (Pro)
POST /api/resume/cover-letter  — Cover letter (Pro)
POST /api/resume/linkedin      — LinkedIn summary (Pro)
POST /api/resume/ats-check     — ATS score (Free)
GET  /api/resume/list          — List my resumes

GET  /api/dashboard            — Dashboard data

GET  /api/admin/stats          — Revenue stats (admin key required)
GET  /api/admin/users          — User list
GET  /api/admin/orders         — Order list
```

## Admin Dashboard

Hit `/api/admin/stats` with header `x-admin-key: admin123` (change this in production via `ADMIN_KEY` env var).

## Deployment

See LAUNCH_GUIDE.md for full step-by-step deployment instructions.

## Revenue Model

- **Starter**: Free (lead generation)
- **Pro**: ₹999 one-time → need 100 sales = ₹99,900/month
- **Career Kit**: ₹1,999 one-time → higher-value upsell

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: LowDB (JSON file, zero setup)
- **Payments**: Razorpay
- **AI**: Anthropic Claude API
- **Email**: Nodemailer (Gmail SMTP)
- **Frontend**: Vanilla JS SPA (no build step)
