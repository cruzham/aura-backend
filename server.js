import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await supabase.from('users').update({ tier: session.metadata.tier, stripe_customer_id: session.customer }).eq('id', session.metadata.userId);
  }
  if (event.type === 'customer.subscription.deleted') {
    await supabase.from('users').update({ tier: 'Sandbox' }).eq('stripe_customer_id', event.data.object.customer);
  }
  res.json({ received: true });
});

app.use(express.json());

const PRICE_IDS = {
  Solo: { monthly: process.env.STRIPE_SOLO_MONTHLY, yearly: process.env.STRIPE_SOLO_YEARLY },
  Scale: { monthly: process.env.STRIPE_SCALE_MONTHLY, yearly: process.env.STRIPE_SCALE_YEARLY },
  Sovereign: { monthly: process.env.STRIPE_SOVEREIGN_MONTHLY, yearly: process.env.STRIPE_SOVEREIGN_YEARLY },
};

app.post('/api/create-checkout', async (req, res) => {
  const { tier, billing, userId } = req.body;
  const priceId = PRICE_IDS[tier]?.[billing];
  if (!priceId) return res.status(400).json({ error: 'Invalid tier or billing' });
  const { data: user } = await supabase.from('users').select('stripe_customer_id, email').eq('id', userId).single();
  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/success`,
    cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    metadata: { userId, tier },
  };
  if (user?.stripe_customer_id) sessionParams.customer = user.stripe_customer_id;
  else if (user?.email) sessionParams.customer_email = user.email;
  const session = await stripe.checkout.sessions.create(sessionParams);
  res.json({ url: session.url });
});

app.post('/api/create-portal-session', async (req, res) => {
  const { userId } = req.body;
  const { data: user } = await supabase.from('users').select('stripe_customer_id').eq('id', userId).single();
  if (!user?.stripe_customer_id) return res.status(404).json({ error: 'No Stripe customer found' });
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${process.env.FRONTEND_URL}/dashboard` });
  res.json({ url: session.url });
});

app.get('/api/health', (req, res) => res.json({ status: 'AuraOS backend online' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AuraOS backend running on port ${PORT}`));
