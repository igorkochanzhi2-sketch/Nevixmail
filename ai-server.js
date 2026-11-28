const http=require('http');
const PORT=process.env.PORT||3001;
const KEY=process.env.GEMINI_KEY||'';
const B='https://generativelanguage.googleapis.com/v1beta/models/';
const TRY=['gemini-3.8-flash','gemini-flash-latest','gemini-3.5-flash','gemini-3.7-flash','gemini-2.5-flash'];
const SYS='Ты NEVIX CODE AI, помощник по коду. Отвечай по-русски, коротко, без звёздочек и без тройных кавычек. Сначала объясни ошибку в 1-2 строках, потом дай исправленный код.';
let good='';
function j(res,c,o){res.writeHead(c,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});res.end(JSON.stringify(o));}
function body(r){return new Promise(x=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>x(b));});}
async function call(m,p){const r=await fetch(B+m+':generateContent?key='+encodeURIComponent(KEY),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:SYS}]},contents:[{role:'user',parts:[{text:p}]}],generationConfig:{temperature:0.4,maxOutputTokens:2048}})});const d=await r.json().catch(()=>({}));const t=((d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts)||[]).map(x=>x.text||'').join('').trim();return {ok:r.ok&&t,t:t,e:(d.error&&d.error.message)||('HTTP '+r.status)};}
http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST'});return res.end();}
 const u=new URL(req.url,'http://x');
 if(u.pathname==='/health')return j(res,200,{ok:true,hasKey:!!KEY,model:good||'(сам)'});
 if(u.pathname==='/probe'){
  const out=[];
  for(const m of TRY){const r=await call(m,'ответь одним словом: работает');out.push(m+': '+(r.ok?'ОК '+r.t.slice(0,20):r.e.slice(0,80)));if(r.ok)return j(res,200,{found:m,out});}
  return j(res,200,{found:null,out});
 }
 if(u.pathname==='/ai'&&req.method==='POST'){
  if(!KEY)return j(res,400,{error:'нет ключа GEMINI_KEY'});
  let d={};try{d=JSON.parse(await body(req));}catch(e){return j(res,400,{error:'плохой запрос'});}
  const q=String(d.question||'').trim();if(!q)return j(res,400,{error:'пустой вопрос'});
  const p=(d.code?'Язык '+d.lang+'\nКод:\n'+String(d.code).slice(0,20000)+'\n\n':'')+'Вопрос: '+q;
  const list=good?[good].concat(TRY):TRY;const errs=[];
  for(const m of list){const r=await call(m,p);if(r.ok){good=m;return j(res,200,{ok:true,text:r.t});}errs.push(m+': '+r.e.slice(0,80));}
  return j(res,502,{error:errs.slice(0,3).join(' | ')});
 }
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 res.end('<!doctype html><meta charset="utf-8"><body style="background:#0a0a0c;color:#f4f4f7;font-family:system-ui;padding:24px"><h2>NEVIX CODE мостик</h2><p>Ключ: '+(KEY?'есть':'нет')+'</p><p><a style="color:#ff7d8b" href="/probe">проверка</a></p></body>');
}).listen(PORT,'0.0.0.0',()=>console.log('мостик на '+PORT));
