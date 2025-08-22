import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import bodyParser from 'body-parser';

const app = express();

const {
  PORT = 8080,
  PUBLIC_ORIGIN = 'https://donate.komasrudy.com',
  CORS_ORIGIN   = PUBLIC_ORIGIN,
  STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET
} = process.env;

if (!STRIPE_SECRET) throw new Error('STRIPE_SECRET missing');

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

// --- CORS ---
app.use(cors({ origin: CORS_ORIGIN }));

// --- WEBHOOK (RAW body) MUSÍ ísť pred JSON parser alebo JSON parser obísť ---
app.post('/api/webhook',
  bodyParser.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = Stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook verify error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      try {
        const session = event.data.object;
        const msg = session.metadata?.message || 'Ďakujeme za podporu!';
        broadcast({ t: 'donation', message: msg });
        console.log('TTS broadcast:', msg);
      } catch (e) {
        console.error('process webhook error', e);
      }
    }
    res.json({ received: true });
  }
);

// --- JSON parser pre všetko ostatné pod /api okrem /api/webhook ---
app.use('/api', (req, res, next) => {
  if (req.path === '/webhook') return next();
  return express.json()(req, res, next);
});

// --- SSE stream pre overlay/TTS ---
const clients = new Set();
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN
  });
  res.write('event: ping\ndata: ok\n\n');

  const client = { res };
  clients.add(client);

  // keepalive
  const iv = setInterval(() => {
    try { res.write('event: ping\ndata: ok\n\n'); } catch {}
  }, 25000);

  req.on('close', () => { clearInterval(iv); clients.delete(client); });
});
const broadcast = payload => {
  const s = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(c => { try { c.res.write(s); } catch {} });
};

// --- Checkout (fixná suma 10 €) ---
app.post('/api/checkout', async (req, res) => {
  try {
    const { message = '' } = req.body || {};
    const clean = String(message)
      .replace(/\s+/g, ' ')
      .replace(/https?:\/\/\S+/g, '[link]')
      .slice(0, 240);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'link'],
      currency: 'eur',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          product_data: { name: 'Podpora streamu (donation)' },
          unit_amount: 1000 // 10 € v centoch
        }
      }],
      success_url: PUBLIC_ORIGIN + '/?paid=1',
      cancel_url:  PUBLIC_ORIGIN + '/?canceled=1',
      metadata: { message: clean }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error', e);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

// --- Health ---
app.get('/', (_req, res) => res.send('rudy-donate backend OK'));

app.listen(Number(PORT), () => console.log('Server on :' + PORT));
