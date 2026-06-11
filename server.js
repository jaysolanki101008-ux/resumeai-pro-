require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const Razorpay    = require('razorpay');
const nodemailer  = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const low         = require('lowdb');
const FileSync    = require('lowdb/adapters/FileSync');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Data directory ───────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database ─────────────────────────────────────────────
const usersDB   = low(new FileSync(path.join(DATA_DIR, 'users.json')));
const ordersDB  = low(new FileSync(path.join(DATA_DIR, 'orders.json')));
const resumesDB = low(new FileSync(path.join(DATA_DIR, 'resumes.json')));
usersDB.defaults({ users: [] }).write();
ordersDB.defaults({ orders: [] }).write();
resumesDB.defaults({ resumes: [] }).write();

// ── DB helpers ───────────────────────────────────────────
const db = {
  createUser({ name, email, phone = '' }) {
    const ex = this.getUserByEmail(email);
    if (ex) return ex;
    const user = { id: uuidv4(), name, email: email.toLowerCase().trim(), phone, plan: 'starter', createdAt: new Date().toISOString(), resumeCount: 0 };
    usersDB.get('users').push(user).write();
    return user;
  },
  getUserByEmail(email) { return usersDB.get('users').find({ email: email.toLowerCase().trim() }).value(); },
  getUserById(id) { return usersDB.get('users').find({ id }).value(); },
  updateUserPlan(userId, plan) { usersDB.get('users').find({ id: userId }).assign({ plan, upgradedAt: new Date().toISOString() }).write(); },
  getAllUsers() { return usersDB.get('users').value(); },
  createOrder({ userId, plan, amount, razorpayOrderId }) {
    const order = { id: uuidv4(), userId, plan, amount, currency: 'INR', razorpayOrderId, razorpayPaymentId: null, status: 'created', createdAt: new Date().toISOString(), paidAt: null };
    ordersDB.get('orders').push(order).write();
    return order;
  },
  getOrderByRazorpayId(razorpayOrderId) { return ordersDB.get('orders').find({ razorpayOrderId }).value(); },
  markOrderPaid(razorpayOrderId, razorpayPaymentId) { ordersDB.get('orders').find({ razorpayOrderId }).assign({ status: 'paid', razorpayPaymentId, paidAt: new Date().toISOString() }).write(); },
  getAllOrders() { return ordersDB.get('orders').value(); },
  getRevenue() {
    const paid = ordersDB.get('orders').filter({ status: 'paid' }).value();
    return { count: paid.length, totalINR: Math.round(paid.reduce((s, o) => s + o.amount, 0) / 100) };
  },
  saveResume({ userId, title, inputData, generatedContent, atsScore }) {
    const r = { id: uuidv4(), userId, title: title || 'Untitled', inputData, generatedContent, atsScore, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    resumesDB.get('resumes').push(r).write();
    usersDB.get('users').find({ id: userId }).update('resumeCount', n => n + 1).write();
    return r;
  },
  getUserResumes(userId) { return resumesDB.get('resumes').filter({ userId }).sortBy('createdAt').reverse().value(); },
  getResumeById(id) { return resumesDB.get('resumes').find({ id }).value(); },
  getAllResumes() { return resumesDB.get('resumes').value(); },
};

// ── Auth helpers ─────────────────────────────────────────
function generateToken(userId, email) { return Buffer.from(`${userId}:${email}`).toString('base64'); }
function parseToken(token) {
  try { const [userId, email] = Buffer.from(token, 'base64').toString().split(':'); return { userId, email }; }
  catch { return null; }
}
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || req.query.token;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  const parsed = parseToken(token);
  if (!parsed) return res.status(401).json({ error: 'Invalid token.' });
  const user = db.getUserById(parsed.userId);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  req.user = user; req.token = token; next();
}
function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!plans.includes(req.user.plan)) return res.status(403).json({ error: 'Upgrade required.', requiredPlan: plans[0], currentPlan: req.user.plan });
    next();
  };
}
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== (process.env.ADMIN_KEY || 'admin123')) return res.status(403).json({ error: 'Forbidden.' });
  next();
}

// ── Email ────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[EMAIL SKIPPED] To: ${to} | ${subject}`); return;
  }
  try {
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: 587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
    console.log(`[EMAIL] Sent to ${to}`);
  } catch(e) { console.error(`[EMAIL ERROR] ${e.message}`); }
}
async function sendWelcomeEmail({ name, email, plan }) {
  await sendEmail({ to: email, subject: `Welcome to ResumeAI Pro, ${name}! 🚀`, html: `<h2>Welcome ${name}!</h2><p>You're on the <b>${plan}</b> plan. <a href="${process.env.APP_URL}/dashboard">Open Dashboard →</a></p>` });
}
async function sendPaymentEmail({ name, email, plan, amount, paymentId }) {
  await sendEmail({ to: email, subject: `✅ Payment confirmed — You're on ${plan}!`, html: `<h2>Payment Successful!</h2><p>Hi ${name}, your ₹${amount} payment (${paymentId}) for <b>${plan}</b> is confirmed. <a href="${process.env.APP_URL}/dashboard">Start building →</a></p>` });
}

// ── AI (Google Gemini) ───────────────────────────────────
let geminiClient = null;
function getGemini() {
  if (!geminiClient && process.env.GEMINI_API_KEY) geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return geminiClient;
}
async function askGemini(prompt) {
  const ai = getGemini();
  if (!ai) throw new Error('GEMINI_API_KEY not set');
  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}
function calcATSScore(resumeText, jd) {
  if (!jd) return 78;
  const words = jd.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const matched = words.filter(w => resumeText.toLowerCase().includes(w));
  return Math.min(98, Math.max(55, Math.round((matched.length / Math.max(words.length, 1)) * 60) + 40));
}
function mockResume({ name, email, phone, location, currentRole, skills }) {
  return {
    name: name || 'Your Name', email: email || 'you@email.com', phone: phone || '+91 98765 43210',
    location: location || 'India', title: currentRole || 'Professional',
    summary: `Results-driven ${currentRole || 'professional'} with a proven track record of delivering high-impact solutions. Adept at cross-functional collaboration and turning requirements into measurable outcomes.`,
    experience: [{ company: 'Tech Corp India', role: currentRole || 'Developer', period: '2022–Present', bullets: ['Reduced API latency by 42% serving 500K daily users', 'Led team of 4 to deliver project 2 weeks ahead of schedule', 'Cut bug rate by 35% through automated testing pipeline'] }],
    education: [{ institution: 'Top University', degree: 'B.Tech Computer Science', year: '2019' }],
    skills: { technical: (skills || 'JavaScript, Node.js, React').split(',').map(s => s.trim()), soft: ['Leadership', 'Problem Solving'] },
    atsScore: 87, note: 'Demo resume — add GEMINI_API_KEY in Render environment variables for live AI generation'
  };
}
async function generateResume(data) {
  if (!process.env.GEMINI_API_KEY) return mockResume(data);
  const { name, email, phone, location, currentRole, yearsExp, experience, education, skills, jobDescription, tone } = data;
  const prompt = `You are a professional resume writer. Generate an ATS-optimised resume.
Name: ${name || 'Candidate'}, Email: ${email}, Phone: ${phone}, Location: ${location || 'India'}
Role: ${currentRole}, Years: ${yearsExp || 3}
Experience: ${experience || 'Not provided'}
Education: ${education || 'Not provided'}
Skills: ${skills || 'Not provided'}
Job Description: ${jobDescription || 'General resume'}
Tone: ${tone || 'professional'}

Return ONLY valid JSON, no markdown, no backticks:
{"name":"","email":"","phone":"","location":"","title":"","summary":"","experience":[{"company":"","role":"","period":"","bullets":[""]}],"education":[{"institution":"","degree":"","year":""}],"skills":{"technical":[""],"soft":[""]},"keywords":[""]}`;
  try {
    const raw = await askGemini(prompt);
    const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const parsed = JSON.parse(clean);
    parsed.atsScore = calcATSScore(JSON.stringify(parsed), jobDescription);
    return parsed;
  } catch(e) { console.error('[AI] Error:', e.message); return mockResume(data); }
}
async function generateCoverLetter(data) {
  if (!process.env.GEMINI_API_KEY) return `I am writing to express my strong interest in the ${data.role} position at ${data.company}.\n\nMy experience in ${data.experience || 'this field'} has prepared me well for this opportunity. I am confident in my ability to contribute meaningfully to your team.\n\nI look forward to discussing this opportunity further. Thank you for your consideration.`;
  const prompt = `Write a professional cover letter for ${data.name} applying for ${data.role} at ${data.company}.
Background: ${data.experience || 'Not provided'}
Job: ${data.jobDescription || 'Not provided'}
Rules: 3 paragraphs, under 280 words, professional tone, return ONLY the letter body (no Dear/Subject line)`;
  try { return await askGemini(prompt); } catch(e) { return 'Cover letter generation failed. Please try again.'; }
}
async function generateLinkedIn(data) {
  if (!process.env.GEMINI_API_KEY) return `Results-driven ${data.role} with a track record of delivering impact. Passionate about solving complex problems and building great products. Open to exciting new opportunities — let's connect!`;
  const prompt = `Write a LinkedIn About section for ${data.name}, a ${data.role}.
Background: ${data.experience || 'Not provided'}, Skills: ${data.skills || 'Not provided'}
Rules: 3-4 sentences, first person, hook opening, mention 2-3 skills, end with what you seek. No hashtags/emojis. Return ONLY the text.`;
  try { return await askGemini(prompt); } catch(e) { return 'LinkedIn generation failed. Please try again.'; }
}

// ── Razorpay ─────────────────────────────────────────────
const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
const PLANS = { pro: { amount: 99900, label: 'Pro Plan' }, 'career-kit': { amount: 199900, label: 'Career Kit' } };

// ════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use('/api/webhook/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 100 }));
app.use('/api/payment/', rateLimit({ windowMs: 60*1000, max: 10 }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, emailAddr, phone } = req.body;
    if (!name || !emailAddr) return res.status(400).json({ error: 'Name and email required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr)) return res.status(400).json({ error: 'Invalid email.' });
    let user = db.getUserByEmail(emailAddr);
    if (!user) { user = db.createUser({ name, email: emailAddr, phone: phone||'' }); await sendWelcomeEmail({ name: user.name, email: user.email, plan: user.plan }); }
    res.json({ success: true, token: generateToken(user.id, user.email), user: { id:user.id, name:user.name, email:user.email, plan:user.plan, resumeCount:user.resumeCount } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailAddr } = req.body;
    if (!emailAddr) return res.status(400).json({ error: 'Email required.' });
    const user = db.getUserByEmail(emailAddr);
    if (!user) return res.status(404).json({ error: 'No account found. Please register first.' });
    res.json({ success: true, token: generateToken(user.id, user.email), user: { id:user.id, name:user.name, email:user.email, plan:user.plan, resumeCount:user.resumeCount } });
  } catch(e) { res.status(500).json({ error: 'Login failed.' }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ user: { id:u.id, name:u.name, email:u.email, plan:u.plan, resumeCount:u.resumeCount } });
});

// ════════════════════════════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan.' });
    const rzpOrder = await rzp.orders.create({ amount: PLANS[plan].amount, currency: 'INR', receipt: `rcpt_${Date.now()}`, notes: { userId: req.user.id, plan } });
    db.createOrder({ userId: req.user.id, plan, amount: PLANS[plan].amount, razorpayOrderId: rzpOrder.id });
    res.json({ success: true, orderId: rzpOrder.id, amount: PLANS[plan].amount, currency: 'INR', key: process.env.RAZORPAY_KEY_ID, name: 'ResumeAI Pro', description: PLANS[plan].label, prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone||'' } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Could not create order.' }); }
});

app.post('/api/payment/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment details.' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed.' });
    const order = db.getOrderByRazorpayId(razorpay_order_id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    db.markOrderPaid(razorpay_order_id, razorpay_payment_id);
    db.updateUserPlan(req.user.id, order.plan);
    const updated = db.getUserById(req.user.id);
    await sendPaymentEmail({ name: req.user.name, email: req.user.email, plan: order.plan, amount: Math.round(order.amount/100), paymentId: razorpay_payment_id });
    res.json({ success: true, message: 'Payment verified!', plan: order.plan, paymentId: razorpay_payment_id, user: { id:updated.id, name:updated.name, email:updated.email, plan:updated.plan } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Verification error.' }); }
});

app.get('/api/payment/status', requireAuth, (req, res) => {
  res.json({ plan: req.user.plan, isPro: ['pro','career-kit'].includes(req.user.plan) });
});

// ════════════════════════════════════════════════════════
//  WEBHOOK
// ════════════════════════════════════════════════════════
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    if (payload.event === 'payment.captured') {
      const { order_id, id: payId } = payload.payload.payment.entity;
      const order = db.getOrderByRazorpayId(order_id);
      if (order && order.status !== 'paid') {
        db.markOrderPaid(order_id, payId);
        db.updateUserPlan(order.userId, order.plan);
        const user = db.getUserById(order.userId);
        if (user) await sendPaymentEmail({ name:user.name, email:user.email, plan:order.plan, amount:Math.round(order.amount/100), paymentId:payId });
      }
    }
    res.json({ received: true });
  } catch(e) { console.error('[WEBHOOK]', e.message); res.status(500).json({ error: 'Webhook failed' }); }
});

// ════════════════════════════════════════════════════════
//  RESUME ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/resume/generate', requireAuth, requirePlan('pro','career-kit'), async (req, res) => {
  try {
    const data = { ...req.body, name: req.body.name||req.user.name, email: req.body.email||req.user.email };
    const generated = await generateResume(data);
    const title = (data.jobDescription ? `${generated.title||data.currentRole} — Optimised` : `${generated.title||data.currentRole} Resume`);
    const saved = db.saveResume({ userId: req.user.id, title, inputData: data, generatedContent: generated, atsScore: generated.atsScore });
    res.json({ success: true, resumeId: saved.id, resume: generated, atsScore: generated.atsScore, title });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Generation failed.' }); }
});

app.post('/api/resume/cover-letter', requireAuth, requirePlan('pro','career-kit'), async (req, res) => {
  try {
    const letter = await generateCoverLetter({ ...req.body, name: req.user.name });
    res.json({ success: true, coverLetter: letter });
  } catch(e) { res.status(500).json({ error: 'Cover letter failed.' }); }
});

app.post('/api/resume/linkedin', requireAuth, requirePlan('pro','career-kit'), async (req, res) => {
  try {
    const summary = await generateLinkedIn({ ...req.body, name: req.user.name });
    res.json({ success: true, linkedInSummary: summary });
  } catch(e) { res.status(500).json({ error: 'LinkedIn failed.' }); }
});

app.get('/api/resume/list', requireAuth, (req, res) => {
  const resumes = db.getUserResumes(req.user.id);
  res.json({ success: true, resumes: resumes.map(r => ({ id:r.id, title:r.title, atsScore:r.atsScore, createdAt:r.createdAt })) });
});

app.get('/api/resume/:id', requireAuth, (req, res) => {
  const r = db.getResumeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  if (r.userId !== req.user.id) return res.status(403).json({ error: 'Not your resume.' });
  res.json({ success: true, resume: r });
});

app.post('/api/resume/ats-check', requireAuth, (req, res) => {
  const { resumeText, jobDescription } = req.body;
  if (!resumeText) return res.status(400).json({ error: 'Resume text required.' });
  const score = calcATSScore(resumeText, jobDescription);
  const tips = score>=85 ? ['Great score! You should pass most ATS filters.','Add more job-specific keywords for a perfect score.'] : score>=70 ? ['Good score but room to improve.','Add keywords from the job description.','Use standard headings: Experience, Education, Skills.'] : ['Low score — resume may get filtered out.','Add relevant keywords from the job description.','Remove tables, images, or unusual formatting.','Use standard bullet points.'];
  res.json({ success: true, score, tips });
});

// ════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, (req, res) => {
  const resumes = db.getUserResumes(req.user.id);
  const features = {
    starter: { aiGeneration:false, pdfExport:false, coverLetter:false, linkedin:false, atsCheck:true },
    pro: { aiGeneration:true, pdfExport:true, coverLetter:true, linkedin:true, atsCheck:true },
    'career-kit': { aiGeneration:true, pdfExport:true, coverLetter:true, linkedin:true, atsCheck:true, expertReview:true }
  };
  res.json({
    success: true,
    user: { id:req.user.id, name:req.user.name, email:req.user.email, plan:req.user.plan, resumeCount:req.user.resumeCount||0 },
    features: features[req.user.plan]||features.starter,
    resumes: resumes.map(r => ({ id:r.id, title:r.title, atsScore:r.atsScore, createdAt:r.createdAt })),
    stats: { resumesCreated:resumes.length, avgAtsScore: resumes.length ? Math.round(resumes.reduce((s,r)=>s+(r.atsScore||0),0)/resumes.length) : 0 }
  });
});

// ════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  const revenue = db.getRevenue();
  res.json({
    users: { total:users.length, starter:users.filter(u=>u.plan==='starter').length, pro:users.filter(u=>u.plan==='pro').length, careerKit:users.filter(u=>u.plan==='career-kit').length },
    revenue: { totalINR:revenue.totalINR, paidOrders:revenue.count },
    target: { goalINR:100000, progressPct:Math.round((revenue.totalINR/100000)*100), remaining:Math.max(0,100000-revenue.totalINR) }
  });
});
app.get('/api/admin/orders', requireAdmin, (req, res) => res.json({ orders: db.getAllOrders() }));
app.get('/api/admin/users', requireAdmin, (req, res) => res.json({ users: db.getAllUsers() }));

// ════════════════════════════════════════════════════════
//  FRONTEND — serve index.html for all non-API routes
// ════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  ResumeAI Pro running on port ${PORT}`);
  console.log(`📦  Environment: ${process.env.NODE_ENV||'development'}`);
  console.log(`💳  Razorpay: ${process.env.RAZORPAY_KEY_ID||'NOT SET'}`);
  console.log(`🤖  Gemini: ${process.env.GEMINI_API_KEY ? 'Connected ✓' : 'NOT SET (using demo mode)'}`);
});

module.exports = app;
