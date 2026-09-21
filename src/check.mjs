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
  const s=String(text).replace(/\s/g,' ');
  const matches=[...s.matchAll(/(\d+[,.]\d{2})\s*€/g)].map(m=>({value:Number(m[1].replace(',','.')),index:m.index??0,raw:m[0]}));
  if (!matches.length) return null;
  const driveIndex=s.toLowerCase().lastIndexOf('dans mon drive');
  if (driveIndex >= 0) {
    const after=matches.find(m=>m.index>driveIndex);
    if (after) return after.value;
  }
  for (const m of matches) {
    const tail=s.slice(m.index+m.raw.length,m.index+m.raw.length+8);
    if (!/^\s*\/\s*kg/i.test(tail)) return m.value;
  }
  return matches.at(-1).value;
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
    // Establish the Eaubonne Drive context before product searches.
    // The official Auchan store page exposes this Drive and a "Choisir ce Drive" action.
    try {
      const driveUrl='https://www.auchan.fr/magasins/drive/auchan-drive-supermarche-eaubonne/s-6159';
      await page.goto(driveUrl,{waitUntil:'domcontentloaded',timeout:30000});
      await page.waitForTimeout(1500);
      const choose=page.getByText(/Choisir ce Drive/i).first();
      if (await choose.count()) {
        await choose.click({timeout:10000});
        await page.waitForTimeout(2500);
        console.log('AUCHAN DRIVE selected via store page:', page.url());
      } else {
        console.log('AUCHAN DRIVE selector not found');
      }
      const journey=await page.request.get('https://www.auchan.fr/journey');
      console.log('AUCHAN JOURNEY AFTER SELECT:', (await journey.text()).replace(/\s+/g,' ').slice(0,2500));
    } catch(e) {
      console.log('AUCHAN DRIVE selection failed:', e.message);
    }
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
          // Inspect individual product cards instead of pairing unrelated prices
          // from the full page. We only accept a card when both a price and €/kg
          // are present in the same DOM block.
          const cards=await page.locator('article, [data-testid*="product"], [class*="product-card"], [class*="productCard"], [class*="product"]').evaluateAll(nodes =>
            nodes.slice(0,80).map(n => ({
              text:(n.innerText||'').replace(/\\s+/g,' ').trim(),
              href:n.querySelector('a[href]')?.href || ''
            })).filter(x => x.text)
          ).catch(()=>[]);
          console.log('AUCHAN CARDS:', product.name, 'count=', cards.length);
          console.log('AUCHAN CARD SAMPLES:', JSON.stringify(cards.slice(0,5)).slice(0,5000));

          let matched=false;
          for (const card of cards) {
            const text=card.text;
            const priceKg=parseKg(text);
            const price=parseEuro(text);
            if (!price || !priceKg) continue;

            // Require meaningful query coverage in the same card.
            const stop=new Set(['avec','sans','pour','dans','saveur','gout','gouts','chocolat']);
            const tokens=query.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[^a-z0-9]+/).filter(t=>t.length>=4 && !stop.has(t));
            const normalized=text.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
            const hits=tokens.filter(t=>normalized.includes(t)).length;
            const needed=tokens.length<=2 ? tokens.length : Math.max(2, Math.ceil(tokens.length*0.6));
            if (tokens.length && hits < needed) continue;

            const promo=/promotion|promo|%|offert|remise|prix choc|avantage/i.test(text);
            offers.push({productId:product.id,productName:product.name,store:store.name,price,pricePerKg:priceKg,promo,url:card.href||page.url()});
            console.log('AUCHAN VERIFIED CARD:',product.name,price,priceKg,promo?'PROMO':'',card.href||'');
            matched=true;
            break;
          }
          if (matched) break;
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
