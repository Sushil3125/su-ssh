/**
 * check-palette.mjs — the host palette's guarantees, re-derived from source.
 *
 * `npm run check:palette`. No dependencies, no browser. Reads PALETTE and
 * PROD_COLOR out of public/js/sessions.js and asserts, in CIEDE2000:
 *
 *   • every pair of host colours, and every host colour against the production
 *     red, is at least ΔE 20 apart (≥30 for the red);
 *   • no host colour sits in the reserved red/pink hue band — red means
 *     production as a *hue*, not merely as a distance;
 *   • the same pairs stay ≥10 apart under simulated protanopia, deuteranopia
 *     and tritanopia (Machado et al. 2009, severity 1.0);
 *   • every host colour clears 3:1 against the rail chrome.
 *
 * Colour is never the only signal in this UI — the label ships with it
 * everywhere — but two live hosts must not be a glance from identical, and the
 * red must never be handed out by the auto-assigner.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hex2rgb = (h) => [1,3,5].map(i => parseInt(h.slice(i,i+2),16));
const srgb2lin = (c) => { c/=255; return c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
function rgb2lab([r,g,b]){
  const R=srgb2lin(r),G=srgb2lin(g),B=srgb2lin(b);
  let X=(0.4124*R+0.3576*G+0.1805*B)/0.95047;
  let Y=(0.2126*R+0.7152*G+0.0722*B)/1.0;
  let Z=(0.0193*R+0.1192*G+0.9505*B)/1.08883;
  const f=t=>t>216/24389?Math.cbrt(t):(841/108)*t+4/29;
  X=f(X);Y=f(Y);Z=f(Z);
  return [116*Y-16,500*(X-Y),200*(Y-Z)];
}
const lum = ([r,g,b]) => 0.2126*srgb2lin(r)+0.7152*srgb2lin(g)+0.0722*srgb2lin(b);
const contrast = (a,b) => { const l1=lum(a),l2=lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };

function ciede2000(lab1, lab2){
  const [L1,a1,b1]=lab1,[L2,a2,b2]=lab2;
  const C1=Math.hypot(a1,b1), C2=Math.hypot(a2,b2), Cb=(C1+C2)/2;
  const G=0.5*(1-Math.sqrt(Cb**7/(Cb**7+25**7)));
  const ap1=(1+G)*a1, ap2=(1+G)*a2;
  const Cp1=Math.hypot(ap1,b1), Cp2=Math.hypot(ap2,b2);
  const deg=x=>x*180/Math.PI, rad=x=>x*Math.PI/180;
  const hp=(a,b)=>{ if(a===0&&b===0)return 0; let h=deg(Math.atan2(b,a)); return h<0?h+360:h; };
  const hp1=hp(ap1,b1), hp2=hp(ap2,b2);
  const dL=L2-L1, dC=Cp2-Cp1;
  let dh; const cp=Cp1*Cp2;
  if(cp===0) dh=0; else { dh=hp2-hp1; if(dh>180)dh-=360; else if(dh<-180)dh+=360; }
  const dH=2*Math.sqrt(cp)*Math.sin(rad(dh)/2);
  const Lb=(L1+L2)/2, Cpb=(Cp1+Cp2)/2;
  let Hb; if(cp===0) Hb=hp1+hp2; else { const d=Math.abs(hp1-hp2);
    if(d<=180) Hb=(hp1+hp2)/2; else Hb=(hp1+hp2+ (hp1+hp2<360?360:-360))/2; }
  const T=1-0.17*Math.cos(rad(Hb-30))+0.24*Math.cos(rad(2*Hb))+0.32*Math.cos(rad(3*Hb+6))-0.20*Math.cos(rad(4*Hb-63));
  const dTh=30*Math.exp(-(((Hb-275)/25)**2));
  const Rc=2*Math.sqrt(Cpb**7/(Cpb**7+25**7));
  const Sl=1+(0.015*(Lb-50)**2)/Math.sqrt(20+(Lb-50)**2);
  const Sc=1+0.045*Cpb, Sh=1+0.015*Cpb*T;
  const Rt=-Math.sin(rad(2*dTh))*Rc;
  return Math.sqrt((dL/Sl)**2+(dC/Sc)**2+(dH/Sh)**2+Rt*(dC/Sc)*(dH/Sh));
}

/* Machado et al. 2009 severity-1.0 CVD matrices (linear RGB). */
const CVD = {
  protan:[[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
  deutan:[[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
  tritan:[[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]],
};
const lin2srgb=(c)=>255*(c<=0.0031308?12.92*c:1.055*c**(1/2.4)-0.055);
function simulate(rgb, kind){
  const m=CVD[kind]; const [R,G,B]=rgb.map(srgb2lin);
  return m.map(row=>Math.min(1,Math.max(0,row[0]*R+row[1]*G+row[2]*B))).map(lin2srgb);
}

const BG = hex2rgb('#1B1719');     // rail/chrome behind the colour bar

function report(hexes, prod){
  const all=[...hexes, prod];
  const labs=all.map(h=>rgb2lab(hex2rgb(h)));
  let min=Infinity, minPair=null;
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
    const d=ciede2000(labs[i],labs[j]);
    if(d<min){min=d;minPair=[all[i],all[j]];}
  }
  const cvd={};
  for(const kind of ['protan','deutan','tritan']){
    const L=all.map(h=>rgb2lab(simulate(hex2rgb(h),kind)));
    let m=Infinity,p=null;
    for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
      const d=ciede2000(L[i],L[j]); if(d<m){m=d;p=[all[i],all[j]];}
    }
    cvd[kind]={min:m,pair:p};
  }
  const cr=Object.fromEntries(all.map(h=>[h, contrast(hex2rgb(h), BG)]));
  return { min, minPair, cvd, contrast: cr };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/js/sessions.js'), 'utf8');
const PALETTE = [...src.match(/export const PALETTE = \[([\s\S]*?)\];/)[1].matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]);
const PROD = src.match(/PROD_COLOR = '(#[0-9A-Fa-f]{6})'/)[1];

const fails = [];
if (PALETTE.length !== 8) fails.push(`expected 8 palette entries, found ${PALETTE.length}`);
const r = report(PALETTE, PROD);
const prodLab = rgb2lab(hex2rgb(PROD));
const toProd = PALETTE.map((h) => [h, ciede2000(rgb2lab(hex2rgb(h)), prodLab)]).sort((a, b) => a[1] - b[1]);

console.log(`palette   ${PALETTE.join(' ')}`);
console.log(`prod      ${PROD}`);
console.log(`min ΔE2000 any pair (prod included)  ${r.min.toFixed(2)}   ${r.minPair.join(' vs ')}`);
console.log(`min ΔE2000 to the production red     ${toProd[0][1].toFixed(2)}   ${toProd[0][0]}`);
for (const k of ['protan', 'deutan', 'tritan']) {
  console.log(`min ΔE2000 under ${k}${' '.repeat(16 - k.length)}${r.cvd[k].min.toFixed(2)}   ${r.cvd[k].pair.join(' vs ')}`);
}
console.log(`contrast on ${'#1B1719'}  ${Object.entries(r.contrast).map(([h, c]) => `${h} ${c.toFixed(2)}`).join('  ')}`);

if (r.min < 20) fails.push(`two colours are only ΔE ${r.min.toFixed(2)} apart (need 20): ${r.minPair.join(' vs ')}`);
if (toProd[0][1] < 30) fails.push(`${toProd[0][0]} is ΔE ${toProd[0][1].toFixed(2)} from the production red (need 30)`);
for (const k of ['protan', 'deutan', 'tritan']) {
  if (r.cvd[k].min < 10) fails.push(`under ${k}, ${r.cvd[k].pair.join(' and ')} are only ΔE ${r.cvd[k].min.toFixed(2)} apart (need 10)`);
}
for (const [h, c] of Object.entries(r.contrast)) {
  if (h !== PROD && c < 3) fails.push(`${h} is only ${c.toFixed(2)}:1 on the rail chrome (need 3)`);
}
for (const h of PALETTE) {
  const [, a, b] = rgb2lab(hex2rgb(h));
  const angle = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  if (angle < 42 || angle >= 330) fails.push(`${h} is in the reserved red/pink hue band (${angle.toFixed(0)}°) — red means production`);
}

if (fails.length) {
  console.error(`\nFAIL\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nOK — the palette holds.');
