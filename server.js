require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');

const authRoutes    = require('./routes/auth');
const payRoutes     = require('./routes/payment');
const resumeRoutes  = require('./routes/resume');
const dashRoutes    = require('./routes/dashboard');
const webhookRoutes = require('./routes/webhook');
const adminRoutes   = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Ensure data dir exists ───────────────────────────────
['data', 'data/resumes', 'data/exports'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ── Security ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "checkout.razorpay.com", "cdn.jsdelivr.net", "fonts.googleapis.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      connectSrc: ["'self'", "api.razorpay.com"],
      frameSrc:   ["'self'", "api.razorpay.com"],
      imgSrc:     ["'self'", "data:", "https:"],
    }
  }
}));

app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));

// ── Webhook MUST use raw body before json middleware ─────
app.use('/api/webhook/razorpay', express.raw({ type: 'application/json' }), webhookRoutes);

// ── Body parsers ─────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts, slow down.' }
});

app.use('/api/', apiLimiter);
app.use('/api/payment/', payLimiter);

// ── Static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/payment',  payRoutes);
app.use('/api/resume',   resumeRoutes);
app.use('/api/dashboard', dashRoutes);
app.use('/api/admin',    adminRoutes);

// ── SPA fallback – serve frontend for all non-API routes ─
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Global error handler ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Something went wrong.'
      : err.message
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀  ResumeAI Pro running on http://localhost:${PORT}`);
  console.log(`📦  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳  Razorpay Key: ${process.env.RAZORPAY_KEY_ID}`);
  console.log(`─────────────────────────────────────────\n`);
});

module.exports = app;
