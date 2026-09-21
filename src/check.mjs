import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

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

function parseEuro(text) {
  const m=String(text).replace(/\s/g,' ').match(/(\d+[,.]\d{2})\s*€/);
  return m ? Number(m[1].replace(',','.')) : null;
}
function parseKg(text) {
  const m=String(text).replace(/\s/g,' ').match(/(\d+[,.]\d{1,2})\s*€\s*\/\s*kg/i);
  return m ? Number(m[1].replace(',','.')) : null;
}

async function collectAuchan() {
  const store=stores.find(s=>s.chain==='Auchan');
  if (!store) return [];
  const browser=await chromium.launch({headless:true});
  const offers=[];
  try {
    const page=await browser.newPage({locale:'fr-FR'});
    const seenNetwork=new Set();
    page.on('response', async response => {
      const type=response.request().resourceType();
      const ct=response.headers()['content-type'] || '';
      if (!['xhr','fetch'].includes(type) && !ct.includes('json')) return;
      const u=response.url();
      if (seenNetwork.has(u)) return;
      seenNetwork.add(u);
      try {
        const text=await response.text();
        if (/price|prix|product|produit|offer|promotion|store|magasin/i.test(text)) {
          console.log('AUCHAN NETWORK:', response.status(), u.slice(0,300));
          console.log('AUCHAN DATA:', text.replace(/\s+/g,' ').slice(0,1200));
        }
      } catch {}
    });
    for (const product of products) {
      for (const query of product.queries) {
        const url='https://www.auchan.fr/recherche?text='+encodeURIComponent(query);
        try {
          await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
          await page.waitForTimeout(2500);
          console.log('AUCHAN PAGE:', page.url(), 'TITLE:', await page.title());
          const storage=await page.evaluate(() => ({
            local:Object.fromEntries(Object.entries(localStorage)),
            session:Object.fromEntries(Object.entries(sessionStorage))
          })).catch(()=>({}));
          const storageText=JSON.stringify(storage);
          if (/store|magasin|drive|shop/i.test(storageText)) console.log('AUCHAN STORAGE:', storageText.slice(0,1800));
          const body=(await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ');
          const priceKg=parseKg(body);
          const price=parseEuro(body);
          const promo=/promotion|promo|%|offert/i.test(body);
          if (price && priceKg) {
            offers.push({productId:product.id,productName:product.name,store:store.name,price,pricePerKg:priceKg,promo,url:page.url()});
            console.log('AUCHAN',product.name,price,priceKg,promo?'PROMO':'');
            break;
          }
          console.log('AUCHAN no verified local price:',product.name,query);
        } catch(e) {
          console.log('AUCHAN failed:',product.name,e.message);
        }
      }
    }
  } finally { await browser.close(); }
  return offers;
}

async function collectOffers() {
  const offers=[];
  console.log(`Monitoring ${products.length} product groups across ${stores.length} configured stores.`);
  offers.push(...await collectAuchan());
  return offers;
}

async function sendEmail(deals) {
  if (!deals.length || process.env.SEND_EMAIL !== 'true') return;
  const required=n=>{if(!process.env[n]) throw new Error(`Missing secret: ${n}`); return process.env[n];};
  const transporter=nodemailer.createTransport({host:required('SMTP_HOST'),port:Number(process.env.SMTP_PORT||465),secure:String(process.env.SMTP_SECURE||'true').toLowerCase()==='true',auth:{user:required('SMTP_USER'),pass:required('SMTP_PASS')}});
  const body=deals.map(d=>[d.productName,d.store,`${d.price.toFixed(2)} € — ${d.pricePerKg.toFixed(2)} €/kg`,d.promo?'PROMOTION':`-${(d.discountVsMedian*100).toFixed(1)} % vs médiane`,d.url||''].join('\n')).join('\n\n');
  await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:required('ALERT_EMAIL'),subject:`🔥 ${deals.length} bonne(s) affaire(s) détectée(s)`,text:body});
}

const offers=await collectOffers();
const deals=findDeals(offers);
console.log(`${offers.length} offres vérifiées, ${deals.length} alertes.`);
await sendEmail(deals);
