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
    const current=comparableKg(o);
    const same=offers.filter(x=>comparisonKey(x)===comparisonKey(o) && x.store!==o.store && Number.isFinite(comparableKg(x)));
    const byStore=new Map();
    for (const x of same) {
      const value=comparableKg(x);
      if (!byStore.has(x.store) || value < byStore.get(x.store)) byStore.set(x.store,value);
    }
    const others=[...byStore.values()];
    if (others.length) {
      o.referencePricePerKg=median(others);
      o.discountVsMedian=Number.isFinite(current) ? 1-current/o.referencePricePerKg : null;
    }
    // Any explicit promotion remains an alert even without enough competitors.
    if (o.promo === true) return true;
    // The 30% rule requires three DISTINCT other stores.
    if (others.length < 3 || !Number.isFinite(current)) return false;
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

function parsePromotion(text, price, pricePerKg) {
  const s=String(text).replace(/\s+/g,' ').trim();
  const second=s.match(/(?:-\s*(\d{1,2})\s*%\s*(?:sur\s*)?(?:le\s*)?2(?:e|ème|eme)|(?:le\s*)?2(?:e|ème|eme)\s*(?:à|a)?\s*-\s*(\d{1,2})\s*%)/i);
  if (second) {
    const pct=Number(second[1]||second[2])/100;
    const factor=(2-pct)/2;
    const pctLabel=Math.round(pct*100);
    return {promo:true,promoType:'SECOND_ITEM_DISCOUNT',promoText:`-${pctLabel}% sur le 2ème article`,promoQuantity:2,effectivePrice:price*factor,effectivePricePerKg:pricePerKg*factor};
  }
  const oneFree=s.match(/(\d+)\s*\+\s*(\d+)\s*(?:offert|gratuits?)/i);
  if (oneFree) {
    const paid=Number(oneFree[1]), free=Number(oneFree[2]), total=paid+free;
    if (paid>0 && total>paid) {
      const factor=paid/total;
      return {promo:true,promoType:'MULTIBUY_FREE',promoText:`${paid} + ${free} offert`,promoQuantity:total,effectivePrice:price*factor,effectivePricePerKg:pricePerKg*factor};
    }
  }
  const direct=s.match(/-\s*(\d{1,2})\s*%/);
  if (direct) {
    const pct=Number(direct[1])/100;
    const factor=1-pct;
    return {promo:true,promoType:'DIRECT_DISCOUNT',promoText:`-${Math.round(pct*100)}% immédiat`,promoQuantity:1,effectivePrice:price*factor,effectivePricePerKg:pricePerKg*factor};
  }
  const promo=/promotion|promo|offert|remise|prix choc|avantage|voir l'offre/i.test(s);
  return {promo,promoType:promo?'OTHER':null,promoText:promo?'Promotion affichée (modalité non calculée)':null,promoQuantity:null,effectivePrice:price,effectivePricePerKg:pricePerKg};
}

function comparableKg(o) {
  return Number.isFinite(o.effectivePricePerKg) ? o.effectivePricePerKg : o.pricePerKg;
}

function validGtin(value) {
  const digits=String(value||'').replace(/\D/g,'');
  if (![8,12,13,14].includes(digits.length)) return null;
  const body=digits.slice(0,-1).split('').reverse();
  const sum=body.reduce((acc,d,i)=>acc+Number(d)*(i%2===0?3:1),0);
  const check=(10-(sum%10))%10;
  return check===Number(digits.at(-1)) ? digits : null;
}

function gtinFromUrl(url) {
  const candidates=String(url||'').match(/(?:^|\D)(\d{8}|\d{12,14})(?:\D|$)/g)||[];
  for (const raw of candidates) {
    const g=validGtin(raw.replace(/\D/g,''));
    if (g) return g;
  }
  return null;
}

async function auchanProductMeta(page, url) {
  if (!url || !/auchan\.fr\/.*\/pr-C/i.test(url)) return {};
  try {
    const response=await page.request.get(url,{timeout:15000});
    if (!response.ok()) return {};
    const html=await response.text();
    let gtin=null;
    const patterns=[
      /(?:GTIN|EAN|Réf\s*\/\s*EAN)[^0-9]{0,80}(\d{13,14})/i,
      /"(?:gtin|gtin13|ean|ean13)"\s*:\s*"?(\d{13,14})"?/i
    ];
    for (const re of patterns) {
      const m=html.match(re);
      gtin=validGtin(m?.[1]);
      if (gtin) break;
    }
    const priceCandidates=[
      html.match(/"price"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/i)?.[1],
      html.match(/"currentPrice"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/i),
      html.match(/"salePrice"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/i)
    ].filter(Boolean).map(x=>Number(String(x).replace(',','.'))).filter(x=>x>0&&x<500);
    const price=priceCandidates[0]??null;
    const kgMatch=html.match(/"unitPrice"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/i);
    const pricePerKg=kgMatch?Number(kgMatch[1].replace(',','.')):null;
    return {gtin,price,pricePerKg};
  } catch(e) {
    console.log('AUCHAN product metadata failed:',url,e.message);
    return {};
  }
}

async function gtinFromProductPage(page, url) {
  return (await auchanProductMeta(page,url)).gtin||null;
}

function comparisonKey(o) {
  // GTIN identifies an exact sellable reference, but comparison is intentionally
  // based on the same product/variant/form so different pack sizes remain comparable in €/kg.
  if (o.comparisonKey && !String(o.comparisonKey).startsWith('gtin:')) return o.comparisonKey;
  const s=String(o.variantName||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const form=/oeuf/.test(s)?'oeuf':/tablette/.test(s)?'tablette':/barre/.test(s)?'barre':/cereale/.test(s)?'cereales':/bonbon/.test(s)?'bonbons':'standard';
  if (o.productId === 'lindt-creation') {
    const flavors=['cookie dough','creme brulee','rocher','fondant','praline','pistache','noisette','caramel','citron','menthe','orange'];
    const flavor=flavors.find(x=>s.includes(x));
    const chocolate=/chocolat blanc|\bblanc\b/.test(s)?'blanc':/chocolat noir|\bnoir\b/.test(s)?'noir':/chocolat au lait|chocolat lait|\blait\b/.test(s)?'lait':'non-precise';
    return `${o.productId}:${form}:${flavor||s.replace(/\b(lindt|creation|de|chocolat|au|lait|noir|blanc)\b/g,' ').replace(/\s+/g,' ').trim()}:${chocolate}`;
  }
  if (o.productId === 'nescafe-cappuccino') {
    const flavors=['kitkat','vanille','chocolat blanc','noisette','praline','caramel beurre sale'];
    const flavor=flavors.find(x=>s.includes(x));
    const preparation=/capsule|dolce gusto/.test(s)?'capsules':/soluble|stick/.test(s)?'soluble':'non-precise';
    return `${o.productId}:${preparation}:${flavor||'classique'}`;
  }
  if (o.productId === 'ferrero-rocher' || o.productId === 'raffaello') return `${o.productId}:${form}`;
  return o.productId;
}

function isValidProductMatch(product, text) {
  const s=String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (product.id==='lindt-creation' && (!/lindt/.test(s) || !/creation/.test(s))) return false;
  if (product.id==='ferrero-rocher' && !/ferrero.*rocher|rocher.*ferrero/.test(s)) return false;
  if (product.id==='raffaello' && !/raffaello/.test(s)) return false;
  if (product.id==='nescafe-cappuccino' && (!/nescafe/.test(s) || !/cappuccino/.test(s) || /dolce gusto|capsule/.test(s))) return false;
  return true;
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
          let nav=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
          await page.waitForTimeout(2500);
          let title=await page.title();
          if (nav?.status()===403 || title==='403') {
            console.log('AUCHAN 403: refreshing Eaubonne Drive context before one retry');
            await page.goto('https://www.auchan.fr/magasins/drive/auchan-drive-supermarche-eaubonne/s-6159',{waitUntil:'domcontentloaded',timeout:30000});
            await page.waitForTimeout(1200);
            const chooseRetry=page.getByText(/Choisir ce Drive/i).first();
            if (await chooseRetry.count()) await chooseRetry.click({timeout:8000}).catch(()=>{});
            await page.waitForTimeout(1200);
            nav=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
            await page.waitForTimeout(2000);
            title=await page.title();
          }
          console.log('AUCHAN PAGE:', page.url(), 'TITLE:', title);
          if (nav?.status()===403 || title==='403') {
            console.log('AUCHAN BLOCKED 403:',query);
            continue;
          }
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
            // Some nested Auchan DOM nodes expose only the €/kg value, causing
            // parseEuro() to mistake it for the package price. Keep the real
            // linked product card and reject these synthetic duplicates.
            if (!card.href && Math.abs(price-priceKg)<0.001) continue;

            // Require meaningful query coverage in the same card.
            const stop=new Set(['avec','sans','pour','dans','saveur','gout','gouts','chocolat']);
            const tokens=query.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[^a-z0-9]+/).filter(t=>t.length>=4 && !stop.has(t));
            const normalized=text.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
            const hits=tokens.filter(t=>normalized.includes(t)).length;
            const needed=tokens.length<=2 ? tokens.length : Math.max(2, Math.ceil(tokens.length*0.6));
            if (tokens.length && hits < needed) continue;

            if (!isValidProductMatch(product,text)) continue;
            const promotion=parsePromotion(text,price,priceKg);
            const variantName=text.split(/\n/).map(x=>x.trim()).find(x=>/lindt|oreo|kinder|lion|ferrero|raffaello|tic tac|nescaf/i.test(x) && x.length>6) || product.name;
            const offerUrl=card.href||page.url();
            const gtin=gtinFromUrl(offerUrl) || await gtinFromProductPage(page,offerUrl);
            if (gtin) console.log('AUCHAN GTIN:',variantName,gtin);
            const cmpKey=comparisonKey({productId:product.id,variantName,gtin});
            if (!offers.some(o=>o.store===store.name && (o.url===offerUrl || (o.comparisonKey===cmpKey && Math.abs(o.price-price)<0.001)))) {
              offers.push({productId:product.id,productName:product.name,variantName,gtin,comparisonKey:cmpKey,store:store.name,price,pricePerKg:priceKg,...promotion,url:offerUrl});
              console.log('AUCHAN VERIFIED CARD:',variantName,price,priceKg,promotion.promo?('PROMO '+promotion.promoText):'',card.href||'');
            }
            matched=true;
            if (!['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
          }
          if (matched && !['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
          console.log('AUCHAN no verified local price:',product.name,query);
        } catch(e) {
          console.log('AUCHAN failed:',product.name,e.message);
        }
      }
    }
  } finally { await browser.close(); }
  return offers;
}

async function lookupAuchanByGtins(gtins) {
  const store=stores.find(s=>s.chain==='Auchan' && s.enabled!==false);
  if (!store || !gtins.length) return [];
  const browser=await chromium.launch({headless:true});
  const offers=[];
  try {
    const page=await browser.newPage({locale:'fr-FR'});
    await page.goto('https://www.auchan.fr/magasins/drive/auchan-drive-supermarche-eaubonne/s-6159',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(1200);
    const choose=page.getByText(/Choisir ce Drive/i).first();
    if (await choose.count()) await choose.click({timeout:8000}).catch(()=>{});
    await page.waitForTimeout(1200);
    for (const item of gtins) {
      const url='https://www.auchan.fr/recherche?text='+encodeURIComponent(item.gtin);
      try {
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
        await page.waitForTimeout(1800);
        const cards=await page.locator('article, [data-testid*="product"], [class*="product-card"], [class*="productCard"], [class*="product"]').evaluateAll(nodes =>
          nodes.slice(0,80).map(n=>({text:(n.innerText||'').replace(/\\s+/g,' ').trim(),href:n.querySelector('a[href]')?.href||''})).filter(x=>x.text&&x.href)
        ).catch(()=>[]);
        let found=false;
        for (const card of cards) {
          const pageGtin=gtinFromUrl(card.href) || await gtinFromProductPage(page,card.href);
          if (pageGtin!==item.gtin) continue;
          const price=parseEuro(card.text), priceKg=parseKg(card.text);
          if (!price || !priceKg) continue;
          const promotion=parsePromotion(card.text,price,priceKg);
          const variantName=card.text.split(/\n/).map(x=>x.trim()).find(x=>/lindt|oreo|kinder|lion|ferrero|raffaello|tic tac|nescaf/i.test(x)&&x.length>6)||item.productName;
          offers.push({productId:item.productId,productName:item.productName,variantName,gtin:item.gtin,store:store.name,price,pricePerKg:priceKg,...promotion,url:card.href});
          console.log('AUCHAN GTIN LOOKUP VERIFIED:',item.gtin,variantName,price,priceKg,card.href);
          found=true; break;
        }
        if (!found) console.log('AUCHAN GTIN LOOKUP MISS:',item.gtin,item.variantName||item.productName);
      } catch(e) { console.log('AUCHAN GTIN LOOKUP ERROR:',item.gtin,e.message); }
    }
  } finally { await browser.close(); }
  return offers;
}

async function collectCarrefour() {
  const store=stores.find(s=>s.chain==='Carrefour' && s.enabled!==false);
  if (!store) return [];
  const offers=[];

  // Carrefour's search pages challenge GitHub-hosted browsers. ReefAPI exposes
  // the same Carrefour catalogue as structured data and can target a postal
  // code, keeping regular price, unit price and promotions separate.
  const apiKey=process.env.REEF_API_KEY;
  if (!apiKey) {
    console.log('CARREFOUR API: REEF_API_KEY absent; Carrefour skipped.');
    return offers;
  }

  for (const product of products) {
    for (const query of product.queries) {
      try {
        const response=await fetch('https://api.reefapi.com/carrefour-fr/v1/search',{
          method:'POST',
          headers:{'content-type':'application/json','x-api-key':apiKey},
          body:JSON.stringify({query,postal_code:'95120',include_unavailable:false})
        });
        if (!response.ok) {
          console.log('CARREFOUR API failed:',product.name,response.status);
          continue;
        }
        const payload=await response.json();
        const rows=payload?.data?.results || [];
        // ReefAPI can omit normalized promotion fields even when Carrefour displays
        // an offer. Inspect only promo-shaped product fields (never credentials).
        if (product.id === 'lindt-creation') {
          const promoDebug=rows.slice(0,8).map(row=>{
            const picked={};
            for (const [k,v] of Object.entries(row||{})) {
              if (/promo|offer|discount|loyal|advantage|deal|campaign|operation|was_price|price/i.test(k)) picked[k]=v;
            }
            return {title:row?.title,gtin:row?.gtin??row?.ean??row?.ean13??row?.barcode??row?.product_code,promo:picked};
          });
          console.log('CARREFOUR LINDT PROMO DEBUG:',JSON.stringify(promoDebug).slice(0,12000));
        }
        let matched=false;
        for (const row of rows) {
          const text=[row.title,row.brand,row.packaging].filter(Boolean).join(' ');
          const normalized=text.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
          const tokens=query.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[^a-z0-9]+/).filter(t=>t.length>=4);
          const distinctive=tokens.filter(t=>!['cappuccino','nescafe','chocolat','cereales','ferrero'].includes(t));
          const required=distinctive.length ? distinctive : tokens;
          if (required.length && !required.some(t=>normalized.includes(t))) continue;
          if (!isValidProductMatch(product,text)) continue;

          const price=Number(row.price?.value ?? row.price ?? row.current_price);
          const unit=Number(row.unit_price?.value ?? row.unit_price ?? row.price_per_unit);
          if (!Number.isFinite(price) || !Number.isFinite(unit)) continue;

          let promotion={promo:false,promoType:null,promoText:null,promoQuantity:null,effectivePrice:price,effectivePricePerKg:unit};
          const promoSource=[
            row.promotion_text,row.promotion?.label,row.promotion?.text,
            ...(Array.isArray(row.multibuy_offers)?row.multibuy_offers.map(x=>x?.label||x?.text||''):[]),
            ...(Array.isArray(row.loyalty_offers)?row.loyalty_offers.map(x=>x?.label||x?.text||''):[])
          ].filter(Boolean).join(' ');
          if (promoSource) promotion=parsePromotion(promoSource,price,unit);
          if (Number(row.was_price)>price && !promotion.promo) {
            const pct=(1-price/Number(row.was_price))*100;
            promotion={promo:true,promoType:'DIRECT_DISCOUNT',promoText:`-${pct.toFixed(0)}% immédiat`,promoQuantity:1,effectivePrice:price,effectivePricePerKg:unit};
          }

          const variantName=row.title || product.name;
          const offerUrl=row.url||store.storePage||'';
          const gtin=validGtin(row.gtin ?? row.ean ?? row.ean13 ?? row.barcode ?? row.product_code) || gtinFromUrl(offerUrl);
          const cmpKey=comparisonKey({productId:product.id,variantName,gtin});
          if (!offers.some(o=>o.store===store.name && o.comparisonKey===cmpKey && o.url===offerUrl)) {
            offers.push({productId:product.id,productName:product.name,variantName,gtin,comparisonKey:cmpKey,store:store.name,price,pricePerKg:unit,...promotion,url:offerUrl});
            console.log('CARREFOUR VERIFIED API:',variantName,price,unit,promotion.promo?('PROMO '+promotion.promoText):'',row.url||'');
          }
          matched=true;
          if (!['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
        }
        if (matched && !['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
        console.log('CARREFOUR API no verified local price:',product.name,query);
      } catch(e) {
        console.log('CARREFOUR API error:',product.name,e.message);
      }
    }
  }
  return offers;
}

async function collectStoreWeb(chain, startUrl, searchUrlFor) {
  const store=stores.find(s=>s.chain===chain && s.enabled!==false);
  if (!store) return [];
  const browser=await chromium.launch({headless:true});
  const offers=[];
  try {
    const page=await browser.newPage({locale:'fr-FR'});
    try {
      await page.goto(startUrl,{waitUntil:'domcontentloaded',timeout:30000});
      await page.waitForTimeout(1800);
      console.log(chain.toUpperCase(),'STORE PAGE:',page.url(),'TITLE:',await page.title());
    } catch(e) { console.log(chain.toUpperCase(),'store context failed:',e.message); }

    for (const product of products) {
      let found=false;
      for (const query of product.queries) {
        try {
          await page.goto(searchUrlFor(query),{waitUntil:'domcontentloaded',timeout:30000});
          await page.waitForTimeout(2200);
          const body=(await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
          if (/formalite|formalité|si vous êtes un humain|access denied|captcha/i.test(body)) {
            console.log(chain.toUpperCase(),'BLOCKED:',page.url());
            return offers;
          }
          const cards=await page.locator('article, li, [role="listitem"], [data-testid], [class*="product"], [class*="Product"], [class*="tile"], [class*="card"]').evaluateAll(nodes=>nodes.slice(0,300).map(n=>({
            text:(n.innerText||'').replace(/\\s+/g,' ').trim(),
            href:n.querySelector('a[href]')?.href||''
          })).filter(x=>x.text && /€/.test(x.text) && x.text.length<1800)).catch(()=>[]);
          console.log(chain.toUpperCase(),'CARDS:',product.name,'count=',cards.length);
          for (const card of cards) {
            const text=card.text;
            if (!isValidProductMatch(product,text)) continue;
            const normalized=text.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
            const tokens=query.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[^a-z0-9]+/).filter(t=>t.length>=4);
            if (tokens.length && !tokens.some(t=>normalized.includes(t))) continue;
            const price=parseEuro(text), priceKg=parseKg(text);
            if (!price || !priceKg) continue;
            const promotion=parsePromotion(text,price,priceKg);
            const variantName=text.split(/\n/).map(x=>x.trim()).find(x=>/lindt|oreo|kinder|lion|ferrero|raffaello|tic tac|nescaf/i.test(x)&&x.length>6)||product.name;
            const offerUrl=card.href||page.url();
            const gtin=gtinFromUrl(offerUrl);
            const cmpKey=comparisonKey({productId:product.id,variantName,gtin});
            offers.push({productId:product.id,productName:product.name,variantName,gtin,comparisonKey:cmpKey,store:store.name,price,pricePerKg:priceKg,...promotion,url:offerUrl});
            console.log(chain.toUpperCase(),'VERIFIED:',variantName,price,priceKg,promotion.promo?('PROMO '+promotion.promoText):'');
            found=true; break;
          }
        } catch(e) { console.log(chain.toUpperCase(),'failed:',product.name,e.message); }
        if(found) break;
      }
    }
  } finally { await browser.close(); }
  return offers;
}

async function collectIntermarche() {
  return collectStoreWeb('Intermarché',
    'https://www.intermarche.com/magasins/07088/ermont-95120/infos-pratiques',
    q=>'https://www.intermarche.com/recherche/'+encodeURIComponent(q));
}
async function collectLeclerc() {
  const store=stores.find(s=>s.chain==='E.Leclerc' && s.enabled!==false);
  if (!store) return [];
  const browser=await chromium.launch({headless:true});
  const offers=[];
  try {
    const page=await browser.newPage({locale:'fr-FR'});
    const start='https://www.leclercdrive.fr/region-ile-de-france/taverny/drive-saint-prix.aspx';
    await page.goto(start,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(1800);
    const host=new URL(page.url()).origin;
    const path=page.url().replace(host,'').replace(/\/drive-saint-prix\.aspx.*$/i,'');
    console.log('E.LECLERC SESSION:',page.url(),'host=',host,'path=',path);
    for (const product of products) {
      let found=false;
      for (const query of product.queries) {
        try {
          // Leclerc search results are server-rendered. Product JSON is embedded in
          // Utilitaires.widget.initOptions(...) calls, so parse the HTML instead of DOM cards.
          const searchUrl=host+path+'/recherche.aspx?TexteRecherche='+encodeURIComponent(query);
          const resp=await page.goto(searchUrl,{waitUntil:'domcontentloaded',timeout:30000});
          await page.waitForTimeout(1200);
          const html=await page.content();
          const rows=[];
          for (const m of html.matchAll(/"objElement"\s*:\s*(\{[^]*?"iIdProduit"[^]*?\})\s*[,}]/g)) {
            try { rows.push(JSON.parse(m[1])); } catch {}
          }
          console.log('E.LECLERC EMBEDDED:',product.name,'count=',rows.length,'url=',page.url());
          for (const row of rows) {
            const variantName=[row.sLibelleLigne1,row.sLibelleLigne2].filter(Boolean).join(' ').trim();
            if (!variantName || !isValidProductMatch(product,variantName)) continue;
            const normalized=variantName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
            const tokens=query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z0-9]+/).filter(t=>t.length>=4);
            if (tokens.length && !tokens.some(t=>normalized.includes(t))) continue;
            const price=Number(row.nrPVUnitaireTTC ?? String(row.sPrixUnitaire||'').replace(',','.').replace(/[^0-9.]/g,''));
            const priceKg=Number(row.nrPVParUniteDeMesureTTC ?? String(row.sPrixParUniteDeMesure||'').replace(',','.').match(/[0-9.]+/)?.[0]);
            if (!Number.isFinite(price)||!Number.isFinite(priceKg)||price<=0||priceKg<=0) continue;
            const promoText=[row.sPrixPromo,row.sLibellePromo,row.sLibelleAvantage].filter(Boolean).join(' ');
            const promotion=parsePromotion(promoText,price,priceKg);
            const gtin=validGtin(row.sEAN ?? row.sEan ?? row.ean ?? row.gtin);
            const cmpKey=comparisonKey({productId:product.id,variantName,gtin});
            const url=page.url();
            if (!offers.some(o=>o.store===store.name&&o.variantName===variantName&&o.price===price)) {
              offers.push({productId:product.id,productName:product.name,variantName,gtin,comparisonKey:cmpKey,store:store.name,price,pricePerKg:priceKg,...promotion,url});
              console.log('E.LECLERC VERIFIED:',variantName,price,priceKg,promotion.promo?('PROMO '+promotion.promoText):'');
            }
            found=true;
            if (!['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
          }
        } catch(e) { console.log('E.LECLERC failed:',product.name,e.message); }
        if(found && !['lindt-creation','nescafe-cappuccino','ferrero-rocher','raffaello'].includes(product.id)) break;
      }
    }
  } finally { await browser.close(); }
  return offers;
}
async function collectMonoprix() {
  return collectStoreWeb('Monoprix',
    'https://courses.monoprix.fr/',
    q=>'https://courses.monoprix.fr/search?text='+encodeURIComponent(q));
}

async function collectOffers() {
  const offers=[];
  console.log(`Monitoring ${products.length} product groups across ${stores.length} configured stores.`);
  offers.push(...await collectAuchan());
  const carrefourOffers=await collectCarrefour();
  offers.push(...carrefourOffers);
  const knownAuchanGtins=new Set(offers.filter(o=>o.store?.includes('Auchan')&&o.gtin).map(o=>o.gtin));
  const crossLookup=[...new Map(carrefourOffers.filter(o=>o.gtin&&!knownAuchanGtins.has(o.gtin)).map(o=>[o.gtin,o])).values()];
  offers.push(...await lookupAuchanByGtins(crossLookup));
  offers.push(...await collectIntermarche());
  offers.push(...await collectLeclerc());
  offers.push(...await collectMonoprix());
  return offers;
}

async function sendEmail(deals) {
  if (!deals.length || process.env.SEND_EMAIL !== 'true') return;
  const required=n=>{if(!process.env[n]) throw new Error(`Missing secret: ${n}`); return process.env[n];};
  const transporter=nodemailer.createTransport({host:required('SMTP_HOST'),port:Number(process.env.SMTP_PORT||465),secure:String(process.env.SMTP_SECURE||'true').toLowerCase()==='true',auth:{user:required('SMTP_USER'),pass:required('SMTP_PASS')}});
  const body=deals.map(d=>{
    const title=d.variantName && d.variantName!==d.productName ? `${d.productName} — ${d.variantName}` : d.productName;
    const lines=[title,d.store,`Prix affiché : ${d.price.toFixed(2)} € — ${d.pricePerKg.toFixed(2)} €/kg`];
    if (d.gtin) lines.push(`EAN/GTIN : ${d.gtin}`);
    if (d.promo) {
      lines.push(`Promo : ${d.promoText||'promotion affichée'}`);
      if (Number.isFinite(d.effectivePrice) && Math.abs(d.effectivePrice-d.price)>0.001) {
        lines.push(`Prix effectif promo : ${d.effectivePrice.toFixed(2)} € / unité — ${d.effectivePricePerKg.toFixed(2)} €/kg${d.promoQuantity? ` (achat de ${d.promoQuantity})`:''}`);
      }
    }
    const competitors=offers.filter(x=>comparisonKey(x)===comparisonKey(d) && x.store!==d.store && Number.isFinite(comparableKg(x))).sort((a,b)=>comparableKg(a)-comparableKg(b));
    if (competitors.length) {
      lines.push('', 'Comparaison autres magasins :');
      for (const x of competitors) lines.push(`- ${x.store}: ${x.price.toFixed(2)} € — ${comparableKg(x).toFixed(2)} €/kg${x.promo?' (promo)':''}`);
      if (Number.isFinite(d.referencePricePerKg) && Number.isFinite(d.discountVsMedian)) {
        const pct=Math.abs(d.discountVsMedian*100).toFixed(1);
        lines.push(`Médiane autres magasins : ${d.referencePricePerKg.toFixed(2)} €/kg — cette offre est ${d.discountVsMedian>=0?pct+' % moins chère':pct+' % plus chère'}.`);
      }
    } else {
      const sameFamily=offers.filter(x=>x.productId===d.productId && x.store!==d.store);
      if (sameFamily.length) {
        lines.push('', 'Comparaison : aucun prix vérifié pour la même variante exacte dans un autre magasin.');
      } else {
        lines.push('', 'Comparaison : aucun autre prix local vérifié disponible pour ce produit.');
      }
    }
    lines.push(d.url||'');
    return lines.join('\n');
  }).join('\n\n--------------------\n\n');
  await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:required('ALERT_EMAIL'),subject:`🔥 ${deals.length} bonne(s) affaire(s) détectée(s)`,text:body});
}

const offers=await collectOffers();
const deals=findDeals(offers);
console.log(`${offers.length} offres vérifiées, ${deals.length} alertes.`);
await sendEmail(deals);
