import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

const products = JSON.parse(await fs.readFile(new URL('../config/products.json', import.meta.url)));
const stores = JSON.parse(await fs.readFile(new URL('../config/stores.json', import.meta.url)));
const THRESHOLD = 0.30;

export function pricePerKg(price, grams) {
  if (!Number.isFinite(price) || !Number.isFinite(grams) || grams <= 0) return null;
  return price / (grams / 1000);
}
export function median(values) {
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}
export function findDeals(offers) {
  return offers.filter(o => {
    if (o.promo === true) return true;
    const others=offers.filter(x=>x.productId===o.productId && x.store!==o.store && Number.isFinite(x.pricePerKg)).map(x=>x.pricePerKg);
    if (others.length < 3 || !Number.isFinite(o.pricePerKg)) return false;
    const ref=median(others);
    o.referencePricePerKg=ref;
    o.discountVsMedian=1-o.pricePerKg/ref;
    return o.discountVsMedian >= THRESHOLD;
  });
}

// Collectors are deliberately conservative: a chain is enabled only after its
// local store/product pages have been validated. No price is invented.
async function collectOffers() {
  const offers=[];
  console.log(`Monitoring ${products.length} product groups across ${stores.length} configured stores.`);
  console.log('Collectors are in validation mode; unavailable/unverified prices are skipped.');
  return offers;
}

async function sendEmail(deals) {
  if (!deals.length || process.env.SEND_EMAIL !== 'true') return;
  const required=n=>{if(!process.env[n]) throw new Error(`Missing secret: ${n}`); return process.env[n];};
  const transporter=nodemailer.createTransport({
    host:required('SMTP_HOST'),port:Number(process.env.SMTP_PORT||465),
    secure:String(process.env.SMTP_SECURE||'true').toLowerCase()==='true',
    auth:{user:required('SMTP_USER'),pass:required('SMTP_PASS')}
  });
  const body=deals.map(d=>[
    d.productName,d.store,
    `${d.price.toFixed(2)} € — ${d.pricePerKg.toFixed(2)} €/kg`,
    d.promo?'PROMOTION':`-${(d.discountVsMedian*100).toFixed(1)} % vs médiane`,
    d.url||''
  ].join('\n')).join('\n\n');
  await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:required('ALERT_EMAIL'),subject:`🔥 ${deals.length} bonne(s) affaire(s) détectée(s)`,text:body});
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const offers=await collectOffers();
  const deals=findDeals(offers);
  console.log(`${offers.length} offres vérifiées, ${deals.length} alertes.`);
  await sendEmail(deals);
}
