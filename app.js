const DB='financeDB', VER=5; let db, state={income:[],expense:[],dues:[],creditcards:[],advances:[],loans:[],notes:[],documents:[]};
const $=id=>document.getElementById(id);
const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const pad=n=>String(n).padStart(2,'0');
const REMINDER_LEAD_DAYS=10;      // start nudging this many days before something's due
const DUE_LOOKBACK_MONTHS=12;     // how far back unpaid dues keep showing as overdue
const TOMBSTONE_TTL_DAYS=180;     // deletion records older than this are pruned during sync
const FREQ_INTERVAL={monthly:1,quarterly:3,halfyearly:6,yearly:12};
const FREQ_LABEL={monthly:'Monthly',quarterly:'Every 3 months',halfyearly:'Every 6 months',yearly:'Yearly'};

// ---------- Date helpers (always local calendar, never toISOString) ----------
function ymd(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function ymOf(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)}
function today(){return ymd(new Date())}
function thisYM(){return ymOf(new Date())}
function parseYMD(s){let[y,m,d]=String(s).split('-').map(Number);return new Date(y,(m||1)-1,d||1)}
function daysInMonth(ym){let[y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate()}
function addMonths(ym,n){let[y,m]=ym.split('-').map(Number);return ymOf(new Date(y,m-1+n,1))}
function monthsBetween(a,b){let[ay,am]=a.split('-').map(Number),[by,bm]=b.split('-').map(Number);return(by-ay)*12+(bm-am)}
function maxYM(a,b){return a>b?a:b}
// A due "day 31" means the last day in shorter months (30 Sep, 28/29 Feb) — never rolls into the next month.
function dateForDay(ym,day){return ym+'-'+pad(Math.min(day,daysInMonth(ym)))}
function dateInMonth(y,m,day){let dim=new Date(y,m+1,0).getDate();return new Date(y,m,Math.min(day,dim))}
function daysFromToday(dateStr){let t=new Date();t.setHours(0,0,0,0);return Math.round((parseYMD(dateStr)-t)/86400000)}
// Google Sheets can turn "2026-10-01" into a real date and hand it back as a UTC
// timestamp ("2026-09-30T18:30:00.000Z") — convert that back to the local date.
function normDate(v){
  if(v==null||v==='')return'';
  let s=String(v);
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  let d=new Date(s);return isNaN(d)?s.slice(0,10):ymd(d)
}
function normYM(v){if(!v)return'';let s=String(v);if(/^\d{4}-\d{2}$/.test(s))return s;return normDate(s).slice(0,7)}
function formatDueDate(dateStr){let d=parseYMD(dateStr);return isNaN(d)?esc(dateStr):d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
function safeDisplayDate(v){if(!v)return'';let d=normDate(v);return /^\d{4}-\d{2}-\d{2}$/.test(d)?formatDueDate(d):esc(String(v))}
function remainingLabelFromDays(diff){
  if(diff>0)return `⏳ Due in ${diff} day${diff===1?'':'s'}`;
  if(diff===0)return'⏰ Due today';
  return `⚠️ Overdue by ${Math.abs(diff)} day${Math.abs(diff)===1?'':'s'}`
}
function parseAmount(s){let n=parseFloat(s);return isFinite(n)&&n>0?Math.round(n*100)/100:0}
function uid(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)}
function val(id){return $(id).value}
const sum=(arr,f=x=>x.amount)=>arr.reduce((a,x)=>a+(+f(x)||0),0);

// ---------- Settings/plan data (budgets, recurring, accounts, categories) ----------
const DEFAULT_META={
  incomeCats:['Salary','Business','Freelance','Investment','Rental','Service Charge','Gift','Interest','Other'],
  expenseCats:['Tea Shop','Petrol','Food','Grocery','Home','Bills','Others'],
  budgets:{},recurring:[],accounts:[],updatedAt:0
};
function freshMeta(){return JSON.parse(JSON.stringify(DEFAULT_META))}
function mergeMeta(m){let out=freshMeta();if(m&&typeof m==='object')for(let k of Object.keys(out))if(m[k]!==undefined)out[k]=m[k];return out}
function loadMeta(){try{return mergeMeta(JSON.parse(localStorage.getItem('dtMeta')||'null'))}catch(e){return freshMeta()}}
let meta=loadMeta();
function saveMeta(touch=true){if(touch)meta.updatedAt=Date.now();try{localStorage.setItem('dtMeta',JSON.stringify(meta))}catch(e){}}
function metaChanged(){saveMeta();render();renderPlan(false);scheduleSync()}

// ---------- Toast + modal ----------
let toastTimer=null;
function toast(msg,{undo=null,action=null,actionText='Undo',type='',ms=6000}={}){
  let el=$('toast');clearTimeout(toastTimer);
  el.className='toast'+(type?' '+type:'');
  el.innerHTML=`<span>${esc(msg)}</span>`;
  let fn=undo||action;
  if(fn){let b=document.createElement('button');b.textContent=undo?'Undo':actionText;b.onclick=()=>{hideToast();fn()};el.appendChild(b)}
  el.hidden=false;
  if(ms)toastTimer=setTimeout(hideToast,ms)
}
function hideToast(){$('toast').hidden=true}
function modal({title='',message='',fields=[],okText='OK',cancelText='Cancel',danger=false}={}){
  return new Promise(resolve=>{
    let dlg=$('modal');
    if(!dlg||typeof dlg.showModal!=='function'){ // very old browser fallback
      if(!fields.length)return resolve(confirm((title?title+'\n\n':'')+message)?{}:null);
      let out={};
      for(let f of fields){if(f.type==='select'){out[f.name]=f.value??(f.options[0]?.value??'');continue}let v=prompt(f.label,f.value??'');if(v===null)return resolve(null);out[f.name]=v}
      return resolve(out)
    }
    dlg.innerHTML=`<form>${title?`<h3>${esc(title)}</h3>`:''}${message?`<p class="muted" style="margin:0">${esc(message)}</p>`:''}${fields.map(f=>`<label>${esc(f.label||'')}${f.type==='select'
      ?`<select name="${esc(f.name)}">${f.options.map(o=>`<option value="${esc(o.value)}"${String(o.value)===String(f.value??'')?' selected':''}>${esc(o.label)}</option>`).join('')}</select>`
      :`<input name="${esc(f.name)}" type="${f.type||'text'}" value="${esc(f.value??'')}"${f.inputmode?` inputmode="${f.inputmode}"`:''}${f.step?` step="${f.step}"`:''}${f.min!=null?` min="${f.min}"`:''} autocomplete="off">`}</label>`).join('')}<div class="btns"><button type="button" class="btn" data-cancel>${esc(cancelText)}</button><button type="submit" class="btn ${danger?'danger':'primary'}">${esc(okText)}</button></div></form>`;
    let done=false;const finish=v=>{if(done)return;done=true;if(dlg.open)dlg.close();resolve(v)};
    let form=dlg.querySelector('form');
    form.onsubmit=e=>{e.preventDefault();let out={};for(let f of fields)out[f.name]=form.elements[f.name].value;finish(out)};
    dlg.querySelector('[data-cancel]').onclick=()=>finish(null);
    dlg.oncancel=e=>{e.preventDefault();finish(null)};
    dlg.onclose=()=>finish(null);
    dlg.showModal();
    let first=form.querySelector('input,select');if(first)setTimeout(()=>first.focus(),30)
  })
}
async function confirmModal(message,okText='OK',danger=false){return!!(await modal({title:'Please confirm',message,okText,danger}))}
function accountOptions(){return[{value:'',label:'— No account —'},...meta.accounts.map(a=>({value:a.id,label:a.name}))]}

// ---------- IndexedDB ----------
function openDB(){return new Promise((res,rej)=>{let r=indexedDB.open(DB,VER);r.onupgradeneeded=()=>{let d=r.result;['income','expense','dues','creditcards','advances','loans','notes','documents','tombstones'].forEach(x=>{if(!d.objectStoreNames.contains(x))d.createObjectStore(x,{keyPath:'id',autoIncrement:true})})};r.onsuccess=()=>{db=r.result;db.onversionchange=()=>{db.close();location.reload()};res()};r.onblocked=()=>alert('Daily Tracker is updating its storage. Please close any other open Daily Tracker tabs/windows, then reopen the app.');r.onerror=()=>rej(r.error)})}
function all(store){return new Promise((res,rej)=>{let r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function putExact(store,obj){return new Promise((res,rej)=>{let tx=db.transaction(store,'readwrite').objectStore(store);let r=obj.id?tx.put(obj):tx.add(obj);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function save(store,obj){obj.updatedAt=Date.now();if(!obj.createdAt)obj.createdAt=obj.updatedAt;return putExact(store,obj)}
function deleteRecord(store,id){return new Promise(res=>{let r=db.transaction(store,'readwrite').objectStore(store).delete(id);r.onsuccess=()=>res();r.onerror=()=>res()})}
// Deletions in synced stores are remembered as tombstones so the next sync
// doesn't quietly restore them from the Sheet.
const SYNCED_STORES=new Set(['income','expense','dues','creditcards','advances','loans','notes']);
function addTombstone(storeName,recordId){
  if(!SYNCED_STORES.has(storeName)||recordId==null)return Promise.resolve();
  let obj={id:storeName+':'+recordId,store:storeName,recordId,deletedAt:Date.now()};
  return new Promise(res=>{let r=db.transaction('tombstones','readwrite').objectStore('tombstones').put(obj);r.onsuccess=()=>res();r.onerror=()=>res()})
}
function removeTombstone(storeName,recordId){return deleteRecord('tombstones',storeName+':'+recordId)}
async function deleteWithTombstone(storeName,id){await addTombstone(storeName,id);await deleteRecord(storeName,id)}
// Delete with an Undo toast instead of a blocking confirm().
async function del(store,id,label='Item'){
  let rec=(state[store]||[]).find(r=>r.id===id);if(!rec)return;
  if(store==='documents'){revokeDocumentUrl(id);await deleteRecord(store,id)}else await deleteWithTombstone(store,id);
  await refreshAndSync();
  toast(label+' deleted',{undo:async()=>{
    await removeTombstone(store,id);
    await save(store,{...rec}); // newer updatedAt than the tombstone, so sync keeps it
    refreshAndSync()
  }})
}
let syncDebounceTimer=null;
function scheduleSync(){
  if(!navigator.onLine)return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer=setTimeout(()=>syncNow(),1200) // a burst of edits syncs once
}
function refreshAndSync(){return refresh().then(scheduleSync)}

// ---------- Migrations of older record shapes ----------
async function normalizeDues(){
  let anyChanged=false,ym=thisYM();
  for(let x of state.dues){
    let changed=false;
    if(!Array.isArray(x.days)){
      x.days=x.day?[x.day]:[];
      x.paidDates=x.paidDates||(x.paid&&x.day?[ym+'-'+pad(x.day)]:[]);
      delete x.day;delete x.paid;changed=true
    }
    if(!x.paidDates){x.paidDates=[];changed=true}
    if(!x.linkedExpenses){x.linkedExpenses={};changed=true}
    if(!x.paymentDates){x.paymentDates={};changed=true}
    if(!x.frequency){x.frequency='monthly';changed=true}
    if(!x.startYM){
      // Older dues had no start month. If you've been marking months paid,
      // start from last month so an unpaid last-month bill shows as overdue;
      // otherwise start fresh this month (no surprise "overdue" pile-up).
      x.startYM=x.paidDates.some(p=>String(p).slice(0,7)<ym)?addMonths(ym,-1):ym;changed=true
    }
    if(changed){await save('dues',x);anyChanged=true}
  }
  if(anyChanged)state.dues=await all('dues')
}
async function normalizeAdvances(){
  let anyChanged=false;
  for(let x of state.advances){
    if(!Array.isArray(x.payments)){
      x.payments=x.status==='settled'?[{date:x.settledDate||today(),amount:x.amount,auto:true}]:[];
      await save('advances',x);anyChanged=true
    }
  }
  if(anyChanged)state.advances=await all('advances')
}
async function normalizeCards(){
  let anyChanged=false;
  for(let x of state.creditcards){
    let changed=false;
    if(!Array.isArray(x.payments)){
      let wasPaid=(x.paidDates||[]).length>0;
      x.payments=wasPaid?[{date:today(),amount:x.balance}]:[];
      if(x.billingDay===undefined)x.billingDay=null;
      changed=true
    }
    // Card-linked spending counts from the statement date onwards.
    if(!x.statementDate){x.statementDate=today();x.statementAt=Date.now();changed=true}
    if(!x.stmtDueDate){x.stmtDueDate=computeCardDue(x,x.statementDate);changed=true}
    if(changed){await save('creditcards',x);anyChanged=true}
  }
  if(anyChanged)state.creditcards=await all('creditcards')
}
let refreshing=null;
async function refresh(){
  // Serialize overlapping refreshes (sync + edits) so they don't interleave writes.
  while(refreshing)await refreshing;
  refreshing=(async()=>{
    for(let k of Object.keys(state))state[k]=await all(k);
    await normalizeDues();await normalizeAdvances();await normalizeCards();
    render();
    if('Notification'in window&&Notification.permission==='granted')checkDueNotifications()
  })();
  try{await refreshing}finally{refreshing=null}
}

// ---------- Category / account selects ----------
function fillSelect(sel,opts,placeholder){
  if(!sel)return;
  let cur=sel.value;
  let norm=opts.map(o=>typeof o==='string'?{value:o,label:o}:o);
  if(placeholder!=null)norm.unshift({value:'',label:placeholder});
  // Keep a value that's no longer in the list (e.g. an old category on a record being edited)
  if(cur&&!norm.some(o=>o.value===cur))norm.push({value:cur,label:cur});
  sel.innerHTML=norm.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if(norm.some(o=>o.value===cur))sel.value=cur
}
function setSelectValue(sel,v,label){
  v=v==null?'':String(v);
  if(![...sel.options].some(o=>o.value===v)){let o=document.createElement('option');o.value=v;o.textContent=label||v||'—';sel.appendChild(o)}
  sel.value=v
}
function accountName(id){if(!id)return'';let a=meta.accounts.find(a=>a.id===id);return a?a.name:'(removed account)'}
function cardName(id){let c=state.creditcards.find(c=>c.id===id);return c?c.cardName:'(removed card)'}
function populateSelects(){
  fillSelect($('iCat'),meta.incomeCats);
  fillSelect($('eCat'),meta.expenseCats);
  let accs=meta.accounts.map(a=>({value:a.id,label:a.name}));
  fillSelect($('iAccount'),accs,'— No account —');
  fillSelect($('eAccount'),accs,'— No account —');
  fillSelect($('rAccount'),accs,'— No account —');
  $('iAccount').classList.toggle('hidden',!meta.accounts.length&&!$('iAccount').value);
  let cards=state.creditcards.map(c=>({value:String(c.id),label:c.cardName}));
  fillSelect($('eCard'),cards,cards.length?'— Which card? —':'No cards added');
  let incCats=[...new Set([...meta.incomeCats,...state.income.map(x=>x.cat||x.source).filter(Boolean)])];
  let expCats=[...new Set([...meta.expenseCats,...state.expense.map(x=>x.cat).filter(Boolean)])];
  fillSelect($('iFCat'),incCats,'All categories');
  fillSelect($('eFCat'),expCats,'All categories');
  fillSelect($('rCat'),val('rType')==='income'?meta.incomeCats:meta.expenseCats);
  onMethodChange()
}
function onMethodChange(){
  let isCard=val('eMethod')==='Card';
  $('eCard').classList.toggle('hidden',!isCard);
  $('eAccount').classList.toggle('hidden',isCard||(!meta.accounts.length&&!$('eAccount').value))
}
function onRecurTypeChange(){
  fillSelect($('rCat'),val('rType')==='income'?meta.incomeCats:meta.expenseCats);
  $('rMethod').classList.toggle('hidden',val('rType')==='income')
}

// ---------- List filters ----------
function filterRows(rows,p,fields,catOf){
  let q=(val(p+'Search')||'').toLowerCase().trim(),cat=val(p+'FCat'),from=val(p+'From'),to=val(p+'To');
  let min=parseFloat(val(p+'Min')),max=parseFloat(val(p+'Max'));
  return rows.filter(x=>
    (!q||fields(x).some(v=>String(v||'').toLowerCase().includes(q)))&&
    (!cat||catOf(x)===cat)&&(!from||x.date>=from)&&(!to||x.date<=to)&&
    (isNaN(min)||x.amount>=min)&&(isNaN(max)||x.amount<=max)
  ).sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt||0)-(a.createdAt||0))
}
function filtersActive(p){return['Search','FCat','From','To','Min','Max'].some(k=>val(p+k))}
function clearFilters(p){['Search','FCat','From','To','Min','Max'].forEach(k=>$(p+k).value='');p==='i'?renderIncomeList():renderExpenseList()}

// ---------- Income ----------
let editingIncomeId=null;
function resetIncomeForm(){$('iAmount').value='';$('iCat').value=meta.incomeCats[0]||'';$('iNote').value='';$('iDate').value=today();$('iAccount').value='';editingIncomeId=null;$('iSaveBtn').textContent='Save Income';$('iCancelEdit').classList.add('hidden')}
async function addIncome(){
  let amount=parseAmount(val('iAmount'));if(!amount)return alert('Enter an amount greater than 0');
  let existing=editingIncomeId?state.income.find(r=>r.id===editingIncomeId):null;
  let obj={...(existing||{}),date:val('iDate')||today(),amount,cat:val('iCat'),note:val('iNote').trim(),account:val('iAccount')};
  delete obj.source;
  await save('income',obj);resetIncomeForm();refreshAndSync();
  toast(existing?'Income updated':'Income saved')
}
function editIncome(id){
  let x=state.income.find(r=>r.id===id);if(!x)return;editingIncomeId=id;
  $('iDate').value=x.date;$('iAmount').value=x.amount;setSelectValue($('iCat'),x.cat||x.source||'Other');
  $('iAccount').classList.remove('hidden');setSelectValue($('iAccount'),x.account||'',accountName(x.account));$('iNote').value=x.note||'';
  $('iSaveBtn').textContent='Update Income';$('iCancelEdit').classList.remove('hidden');show('income');window.scrollTo(0,0)
}
function renderIncomeList(){
  let rows=filterRows(state.income,'i',x=>[x.date,x.cat||x.source,x.note,accountName(x.account)],x=>x.cat||x.source);
  $('iTotal').textContent=rows.length?`${rows.length} record${rows.length===1?'':'s'} · Total ${money(sum(rows))}${filtersActive('i')?' (filtered)':''}`:'';
  $('incomeList').innerHTML=rows.map(x=>`<div class="row" id="row-income-${x.id}"><span>${esc(x.date)}</span><b class="income">${money(x.amount)}</b><span>${esc(x.cat||x.source||'')}</span><span>${esc(x.note)}${x.account?` <span class="muted">· ${esc(accountName(x.account))}</span>`:''}${x.recurKey?' <span class="muted">🔁</span>':''}</span><span class="actions"><button class="btn" onclick="editIncome(${x.id})">Edit</button><button class="btn danger" onclick="del('income',${x.id},'Income')">Delete</button></span></div>`).join('')
    ||`<p class="muted">${filtersActive('i')?'No income matches these filters.':'💰 No income records yet — add your first one above.'}</p>`
}

// ---------- Expense ----------
let editingExpenseId=null;
function resetExpenseForm(){
  $('eAmount').value='';$('eNote').value='';$('eDate').value=today();
  // start on your most-used category and last payment method
  setSelectValue($('eCat'),qaCats('expense')[0]||'Others');
  setSelectValue($('eMethod'),localStorage.getItem('eLastMethod')||'Cash');
  $('eCard').value=localStorage.getItem('eLastCard')||'';$('eAccount').value=localStorage.getItem('eLastAccount')||'';
  editingExpenseId=null;$('eSaveBtn').textContent='Save Expense';$('eCancelEdit').classList.add('hidden');onMethodChange();renderExpenseFastForm()
}
async function addExpense(){
  let amount=parseAmount(val('eAmount'));if(!amount)return alert('Enter an amount greater than 0');
  let method=val('eMethod'),cardId=method==='Card'?(+val('eCard')||null):null;
  if(method==='Card'&&state.creditcards.length&&!cardId)return alert('Pick which card this was paid with (or choose another payment method).');
  let existing=editingExpenseId?state.expense.find(r=>r.id===editingExpenseId):null;
  let obj={...(existing||{}),date:val('eDate')||today(),amount,cat:val('eCat'),method,note:val('eNote').trim(),account:method==='Card'?'':val('eAccount'),cardId};
  let id=await save('expense',obj);
  if(existing)resetExpenseForm();
  else{ // keep category, method and date for the next entry — just clear amount + note
    $('eAmount').value='';$('eNote').value='';
    localStorage.setItem('eLastMethod',method);if(cardId)localStorage.setItem('eLastCard',String(cardId));localStorage.setItem('eLastAccount',obj.account||'')
  }
  await refreshAndSync();
  let undo=()=>deleteWithTombstone('expense',id).then(refreshAndSync);
  if(!existing||existing.cat!==obj.cat||existing.amount!==obj.amount||existing.date!==obj.date)checkBudget(obj.cat,obj.date,()=>toast(existing?'Expense updated':`✅ ${money(amount)} · ${obj.cat} saved`,existing?{}:{undo}));
  else toast('Expense updated')
}
// ---------- Fast expense entry (chips) ----------
const CAT_ICONS={'tea shop':'☕','tea':'☕','petrol':'⛽','fuel':'⛽','food':'🍛','grocery':'🛒','home':'🏠','bills':'🧾','emi':'🏦','others':'📦','other':'📦','travel':'🚌','transport':'🚌','medical':'💊','health':'💊','shopping':'🛍️','education':'📚','school':'📚','entertainment':'🎬','mobile':'📱','recharge':'📱','rent':'🏘️','salary':'💼','business':'🏪','freelance':'💻','investment':'📈','rental':'🏘️','service charge':'🧰','gift':'🎁','interest':'💹','clothes':'👕','vehicle':'🏍️','bike':'🏍️'};
function catIcon(c){return CAT_ICONS[String(c||'').toLowerCase()]||'🏷️'}
const METHOD_ICONS={Cash:'💵',UPI:'📱',Bank:'🏦',Card:'💳'};
const AMT_PRESETS=[10,20,50,100,200];
let eCatList=[],eRepeatList=[];
// expenses you log again and again (same category, amount, method, note) in the last 60 days
function frequentExpenses(n=6){
  let cutoff=ymd(new Date(Date.now()-60*86400000)),map=new Map();
  for(let x of state.expense){
    if(x.date<cutoff||x.recurKey||/\((auto|recurring)\)$/.test(x.note||'')||x.cat==='EMI')continue;
    let k=[x.cat,x.amount,x.method||'',(x.note||'').trim().toLowerCase(),x.cardId||'',x.account||''].join('|');
    let e=map.get(k)||{x,count:0,last:''};e.count++;if(x.date>=e.last){e.last=x.date;e.x=x}map.set(k,e)
  }
  return[...map.values()].filter(e=>e.count>=2).sort((a,b)=>b.count-a.count||b.last.localeCompare(a.last)).slice(0,n).map(e=>e.x)
}
function renderExpenseFastForm(){
  if(!$('eCatChips'))return;
  let cur=val('eCat');eCatList=qaCats('expense');if(cur&&!eCatList.includes(cur))eCatList=[cur,...eCatList];
  $('eCatChips').innerHTML=eCatList.map((c,i)=>`<button type="button" class="chip-btn ${c===cur?'on':''}" onclick="pickECat(${i})">${catIcon(c)} ${esc(c)}</button>`).join('');
  let m=val('eMethod');
  $('eMethodChips').innerHTML=['Cash','UPI','Bank','Card'].map(x=>`<button type="button" class="chip-btn ${x===m?'on':''}" onclick="pickEMethod('${x}')">${METHOD_ICONS[x]} ${x}</button>`).join('');
  let amt=parseFloat(val('eAmount'));
  $('eAmtChips').innerHTML=AMT_PRESETS.map(a=>`<button type="button" class="chip-btn ${amt===a?'on':''}" style="min-width:56px" onclick="setEAmount(${a})">₹${a}</button>`).join('');
  let d=val('eDate'),y=ymd(new Date(Date.now()-86400000));
  document.querySelectorAll('#eDateChips [data-d]').forEach(b=>b.classList.toggle('on',(b.dataset.d==='today'&&d===today())||(b.dataset.d==='yesterday'&&d===y)));
  eRepeatList=editingExpenseId?[]:frequentExpenses();
  $('eRepeatWrap').classList.toggle('hidden',!eRepeatList.length);
  $('eRepeat').innerHTML=eRepeatList.map((x,i)=>`<button type="button" class="repeat-chip" onclick="repeatExpense(${i})">${catIcon(x.cat)} ${esc(x.note||x.cat)} ${money(x.amount)}<small>${esc(x.cat)}${x.method?' · '+esc(x.method):''}${x.cardId?' · '+esc(cardName(x.cardId)):''}</small></button>`).join('');
  let notes=[...new Set(state.expense.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).map(x=>(x.note||'').trim()).filter(n=>n&&!/\((auto|recurring)\)$/.test(n)))].slice(0,40);
  $('eNoteList').innerHTML=notes.map(n=>`<option value="${esc(n)}">`).join('');
  $('eCard').parentElement.classList.toggle('hidden',$('eCard').classList.contains('hidden')&&$('eAccount').classList.contains('hidden'));
  let t=state.expense.filter(x=>x.date===today());
  $('eTodayTotal').textContent=t.length?`Today: ${money(sum(t))} in ${t.length} expense${t.length===1?'':'s'}`:'Nothing spent today yet'
}
function pickECat(i){setSelectValue($('eCat'),eCatList[i]);renderExpenseFastForm()}
function pickEMethod(m){setSelectValue($('eMethod'),m);onMethodChange();renderExpenseFastForm()}
function setEAmount(a){$('eAmount').value=a;renderExpenseFastForm()}
function setEDate(which){$('eDate').value=which==='yesterday'?ymd(new Date(Date.now()-86400000)):today();renderExpenseFastForm()}
async function repeatExpense(i){
  let x=eRepeatList[i];if(!x)return;
  let obj={date:val('eDate')||today(),amount:x.amount,cat:x.cat,method:x.method||'',note:x.note||'',account:x.account||'',cardId:x.cardId||null};
  let id=await save('expense',obj);await refreshAndSync();
  checkBudget(obj.cat,obj.date,()=>toast(`✅ ${catIcon(obj.cat)} ${obj.note||obj.cat} ${money(obj.amount)} added`,{undo:()=>deleteWithTombstone('expense',id).then(refreshAndSync)}))
}
function editExpense(id){
  let x=state.expense.find(r=>r.id===id);if(!x)return;editingExpenseId=id;
  $('eDate').value=x.date;$('eAmount').value=x.amount;setSelectValue($('eCat'),x.cat||'Others');
  setSelectValue($('eMethod'),x.method||'Cash');
  if(x.cardId)setSelectValue($('eCard'),String(x.cardId),cardName(x.cardId));else $('eCard').value='';
  $('eAccount').classList.remove('hidden');setSelectValue($('eAccount'),x.account||'',accountName(x.account));
  $('eNote').value=x.note||'';onMethodChange();renderExpenseFastForm();
  $('eSaveBtn').textContent='Update Expense';$('eCancelEdit').classList.remove('hidden');show('expense');window.scrollTo(0,0)
}
async function deleteExpense(id){
  // If this expense was auto-logged by a due, deleting it must also un-mark that due.
  let due=state.dues.find(d=>Object.values(d.linkedExpenses||{}).map(Number).includes(id));
  if(due){
    if(!await confirmModal(`This expense was logged automatically when "${due.name}" was marked paid. Deleting it will mark that due as unpaid again.`,'Delete',true))return;
    let key=Object.keys(due.linkedExpenses).find(k=>+due.linkedExpenses[k]===id);
    due.paidDates=(due.paidDates||[]).filter(p=>p!==key);
    delete due.paymentDates[key];delete due.linkedExpenses[key];
    await save('dues',due);await deleteWithTombstone('expense',id);refreshAndSync();
    return toast('Expense deleted — "'+due.name+'" is unpaid again')
  }
  del('expense',id,'Expense')
}
function renderExpenseList(){
  let rows=filterRows(state.expense,'e',x=>[x.date,x.cat,x.method,x.note,accountName(x.account),x.cardId?cardName(x.cardId):''],x=>x.cat);
  $('eTotal').textContent=rows.length?`${rows.length} record${rows.length===1?'':'s'} · Total ${money(sum(rows))}${filtersActive('e')?' (filtered)':''}`:'';
  $('expenseList').innerHTML=rows.map(x=>{
    let via=x.cardId?cardName(x.cardId):x.account?accountName(x.account):'';
    let meth=[x.method,via].filter(Boolean).join(' · ');
    return `<div class="row" id="row-expense-${x.id}"><span>${esc(x.date)}</span><b class="expense">${money(x.amount)}</b><span>${esc(x.cat)}</span><span>${esc(x.note)} ${meth?`<span class="muted">(${esc(meth)})</span>`:''}${x.recurKey?' <span class="muted">🔁</span>':''}</span><span class="actions"><button class="btn" onclick="editExpense(${x.id})">Edit</button><button class="btn danger" onclick="deleteExpense(${x.id})">Delete</button></span></div>`
  }).join('')||`<p class="muted">${filtersActive('e')?'No expenses match these filters.':'💸 No expense records yet — add your first one above.'}</p>`
}

// ---------- Budgets ----------
function monthSpend(cat,ym){return sum(state.expense.filter(x=>x.cat===cat&&x.date.startsWith(ym)))}
async function checkBudget(cat,date,okToast=()=>toast('Expense saved')){
  let limit=+meta.budgets[cat]||0,ym=thisYM();
  if(!limit||!String(date).startsWith(ym)){okToast();return}
  let spent=monthSpend(cat,ym),pct=spent/limit*100;
  let msg=null;
  if(pct>=100)msg=`Over budget: ${cat} is at ${money(spent)} of ${money(limit)} this month`;
  else if(pct>=80)msg=`Heads up: ${cat} has used ${Math.round(pct)}% of its ${money(limit)} budget`;
  if(!msg){okToast();return}
  toast(msg,{type:'warn',ms:8000});
  if('Notification'in window&&Notification.permission==='granted'&&'serviceWorker'in navigator){
    let key='budget-'+cat+'-'+ym+'-'+(pct>=100?'100':'80');
    let notified=loadNotified();
    if(!notified[key]){
      notified[key]=today();saveNotified(notified);
      try{(await navigator.serviceWorker.ready).showNotification('Budget alert: '+cat,{body:msg,tag:key,icon:'icon-192.png',badge:'icon-192.png'})}catch(e){}
    }
  }
}
function renderDashBudgets(){
  let entries=Object.entries(meta.budgets).filter(([,v])=>+v>0);
  $('dashBudgetsWrap').classList.toggle('hidden',!entries.length);
  let ym=thisYM();
  $('dashBudgets').innerHTML=entries.map(([cat,limit])=>{
    let spent=monthSpend(cat,ym),pct=spent/limit*100,cls=pct>=100?'over':pct>=80?'warn':'';
    return `<div class="budget-row"><b>${esc(cat)}</b><div class="bar ${cls}"><i style="width:${Math.min(pct,100).toFixed(1)}%"></i></div><span class="${pct>=100?'expense':'muted'}" style="text-align:right">${money(spent)} / ${money(limit)}</span></div>`
  }).join('')
}
function renderBudgetForm(){
  $('budgetForm').innerHTML=meta.expenseCats.map((c,i)=>`<div class="budget-edit"><span>${esc(c)}</span><input class="inp" type="number" min="0" step="1" data-budget-idx="${i}" placeholder="No limit" value="${esc(meta.budgets[c]||'')}"></div>`).join('')||'<p class="muted">Add an expense category first.</p>'
}
function saveBudgets(){
  let b={};
  document.querySelectorAll('[data-budget-idx]').forEach(inp=>{let cat=meta.expenseCats[+inp.dataset.budgetIdx];let v=parseAmount(inp.value);if(cat&&v)b[cat]=v});
  meta.budgets=b;metaChanged();toast('Budgets saved')
}

// ---------- Dues (monthly / quarterly / half-yearly / yearly) ----------
let editingDueId=null;
function parseDays(str){return[...new Set(String(str).split(',').map(s=>parseInt(s.trim(),10)).filter(n=>n>=1&&n<=31))].sort((a,b)=>a-b)}
function resetDueForm(){$('dueName').value='';$('dueAmount').value='';$('dueDay').value='';$('dueFreq').value='monthly';$('dueStart').value=thisYM();editingDueId=null;$('dueSaveBtn').textContent='Save Due';$('dueCancelEdit').classList.add('hidden')}
async function addDue(){
  let name=val('dueName').trim(),amount=parseAmount(val('dueAmount')),days=parseDays(val('dueDay'));
  if(!name||!amount||!days.length)return alert('Enter due name, an amount greater than 0 and at least one valid due day (1-31, comma-separated for more than one)');
  let existing=editingDueId?state.dues.find(d=>d.id===editingDueId):null;
  // keep payment history + links on edit (previously lost, which orphaned auto-logged expenses)
  let obj={...(existing||{}),name,amount,days,frequency:val('dueFreq')||'monthly',startYM:val('dueStart')||thisYM(),
    paidDates:existing?.paidDates||[],linkedExpenses:existing?.linkedExpenses||{},paymentDates:existing?.paymentDates||{}};
  await save('dues',obj);resetDueForm();refreshAndSync();toast(existing?'Due updated':'Due saved')
}
function editDue(id){
  let x=state.dues.find(r=>r.id===id);if(!x)return;editingDueId=id;
  $('dueName').value=x.name;$('dueAmount').value=x.amount;$('dueDay').value=(x.days||[]).join(', ');$('dueFreq').value=x.frequency||'monthly';$('dueStart').value=x.startYM||thisYM();
  $('dueSaveBtn').textContent='Update Due';$('dueCancelEdit').classList.remove('hidden');show('dues');window.scrollTo(0,0)
}
async function deleteDue(id){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  if(!await confirmModal('Delete "'+x.name+'"? This also removes any expenses it auto-logged when marked paid.','Delete',true))return;
  for(let expId of Object.values(x.linkedExpenses||{}))await deleteWithTombstone('expense',+expId);
  await deleteWithTombstone('dues',id);refreshAndSync();toast('Due deleted')
}
function dueOccursIn(x,ym){let diff=monthsBetween(x.startYM||ym,ym);return diff>=0&&diff%(FREQ_INTERVAL[x.frequency]||1)===0}
// the key actually stored for a paid occurrence (new clamped key, or an old unclamped "…-31" key)
function paidKey(x,ym,day){let p=x.paidDates||[];let k=dateForDay(ym,day);if(p.includes(k))return k;let legacy=ym+'-'+pad(day);return p.includes(legacy)?legacy:null}
function dueOccurrences(x,fromYM,toYM){
  let out=[];
  for(let ym=fromYM,guard=0;monthsBetween(ym,toYM)>=0&&guard<60;ym=addMonths(ym,1),guard++){
    if(!dueOccursIn(x,ym))continue;
    for(let day of (x.days||[])){let key=paidKey(x,ym,day);out.push({due:x,ym,day,dateStr:dateForDay(ym,day),paid:!!key,key})}
  }
  return out
}
function dueFloorYM(x){return maxYM(addMonths(thisYM(),-DUE_LOOKBACK_MONTHS),x.startYM||thisYM())}
// Unpaid occurrences: anything overdue (carried over from earlier months), everything
// this month, plus next month's early ones that fall inside the reminder window.
function pendingDueOccurrences(){
  let now=new Date(),ym=thisYM();
  let toYM=ymOf(new Date(now.getFullYear(),now.getMonth(),now.getDate()+REMINDER_LEAD_DAYS));
  let out=[];
  for(let x of state.dues){
    let from=dueFloorYM(x);if(from>toYM)continue;
    for(let o of dueOccurrences(x,from,toYM))if(!o.paid&&(o.ym<=ym||daysFromToday(o.dateStr)<=REMINDER_LEAD_DAYS))out.push(o)
  }
  return out.sort((a,b)=>a.dateStr.localeCompare(b.dateStr))
}
function nextDueOccurrence(x){
  let ym=thisYM();
  for(let i=1;i<=24;i++){let m=addMonths(ym,i);if(dueOccursIn(x,m)&&m>=(x.startYM||m))return{dateStr:dateForDay(m,(x.days||[])[0]||1)}}
  return null
}
async function toggleDue(id,ym,day){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  x.paidDates=x.paidDates||[];x.linkedExpenses=x.linkedExpenses||{};x.paymentDates=x.paymentDates||{};
  let key=paidKey(x,ym,day);
  if(key){
    x.paidDates=x.paidDates.filter(p=>p!==key);delete x.paymentDates[key];
    let expId=x.linkedExpenses[key];
    if(expId){await deleteWithTombstone('expense',+expId);delete x.linkedExpenses[key]}
    await save('dues',x);await refreshAndSync();
    toast(`${x.name} (${formatDueDate(dateForDay(ym,day))}) marked unpaid`,{undo:()=>toggleDue(id,ym,day)})
  }else{
    key=dateForDay(ym,day);
    x.paidDates.push(key);x.paymentDates[key]=today();
    // the expense is dated on the day you actually paid, not the bill's due date
    let expId=await save('expense',{date:today(),amount:x.amount,cat:'Bills',method:'',note:x.name+' (auto)'});
    x.linkedExpenses[key]=expId;
    await save('dues',x);await refreshAndSync();
    toast(`${x.name} marked paid · expense logged`,{undo:()=>toggleDue(id,ym,day)})
  }
}
function duePill(o){
  let x=o.due,paidOn=o.key&&x.paymentDates?x.paymentDates[o.key]:null,diff=daysFromToday(o.dateStr);
  let label=o.paid?'✓ Paid'+(paidOn?' on '+formatDueDate(paidOn):''):remainingLabelFromDays(diff);
  return `<span class="pill ${o.paid?'paid':diff<0?'overdue':''}" style="cursor:pointer" title="Tap to mark ${o.paid?'unpaid':'paid'}" onclick="toggleDue(${x.id},'${o.ym}',${o.day})">${formatDueDate(o.dateStr)}: ${label}</span>`
}
function renderDues(){
  let ym=thisYM();
  $('dueList').innerHTML=state.dues.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(x=>{
    let occ=dueOccurrences(x,dueFloorYM(x),ym).filter(o=>o.ym===ym||!o.paid);
    let pills=occ.map(duePill).join(' ');
    if(!occ.some(o=>o.ym===ym)){let n=nextDueOccurrence(x);if(n)pills+=` <span class="muted" style="font-size:12.5px">Next due ${formatDueDate(n.dateStr)} ${n.dateStr.slice(0,4)}</span>`}
    return `<div class="due-flex" id="row-dues-${x.id}"><span style="min-width:140px"><b>${esc(x.name)}</b><br><span class="muted" style="font-size:12px">${FREQ_LABEL[x.frequency]||'Monthly'}</span></span><span style="min-width:80px">${money(x.amount)}</span><span class="actions" style="flex:1;flex-wrap:wrap">${pills}</span><span class="actions"><button class="btn" onclick="editDue(${x.id})">Edit</button><button class="btn danger" onclick="deleteDue(${x.id})">Delete</button></span></div>`
  }).join('')||'<p class="muted">📅 No dues yet — add a bill above.</p>';
  let items=pendingDueOccurrences().map(o=>{let diff=daysFromToday(o.dateStr);return{date:o.dateStr,html:`<div class="row"><b>${esc(o.due.name)}</b><span>${money(o.due.amount)}</span><span>${formatDueDate(o.dateStr)}</span><span class="pill ${diff<0?'overdue':''}" style="cursor:pointer" title="Tap to mark paid" onclick="toggleDue(${o.due.id},'${o.ym}',${o.day})">${remainingLabelFromDays(diff)}</span></div>`}});
  items.push(...pendingEmiItems(),...pendingCardItems());
  items.sort((a,b)=>a.date.localeCompare(b.date));
  updateNavBadge(items);
  $('dashDues').innerHTML=items.map(i=>i.html).join('')||'<p class="muted">✅ Nothing pending — you\'re all caught up!</p>'
}

// ---------- Credit Cards ----------
// Model: each card has a current BILL (balance, bill date = statementDate, due date = stmtDueDate,
// optional minimum due). Payments count against that bill. Card expenses logged after the bill
// date are "unbilled" — they belong to the NEXT bill, so they never make a paid bill look overdue.
let editingCardId=null;
function resetCardForm(){['cardName','cardBalance','cardLimit','cardBillingDay','cardCycleDays','cardDueDay','cardStmtDue'].forEach(k=>$(k).value='');delete $('cardStmtDue').dataset.touched;$('cardPreview').innerHTML='';editingCardId=null;$('cardSaveBtn').textContent='Save Card';$('cardCancelEdit').classList.add('hidden')}
function billOnOrBefore(billingDay,ref){let r=parseYMD(ref),b=dateInMonth(r.getFullYear(),r.getMonth(),billingDay);return b<=r?b:dateInMonth(r.getFullYear(),r.getMonth()-1,billingDay)}
function billAfter(billingDay,ref){let r=parseYMD(ref),b=dateInMonth(r.getFullYear(),r.getMonth(),billingDay);return b>r?b:dateInMonth(r.getFullYear(),r.getMonth()+1,billingDay)}
// due date of the bill generated on/before `ref`
function computeCardDue(x,ref){
  ref=ref||today();
  if(x.billingDay){
    let bill=billOnOrBefore(x.billingDay,ref);
    if(x.cycleDays){let d=new Date(bill);d.setDate(d.getDate()+(+x.cycleDays));return ymd(d)}
    let dd=x.dueDay||x.billingDay;
    return ymd(dateInMonth(bill.getFullYear(),bill.getMonth()+(dd>x.billingDay?0:1),dd))
  }
  // only a due day: the first due day on/after the bill date
  let r=parseYMD(ref),dd=x.dueDay||1,d=dateInMonth(r.getFullYear(),r.getMonth(),dd);
  if(d<r)d=dateInMonth(r.getFullYear(),r.getMonth()+1,dd);
  return ymd(d)
}
function cardStmtDue(x){return x.stmtDueDate||computeCardDue(x,x.statementDate||today())}
function cardSpendExpenses(x){
  if(!x.statementDate)return[];
  return state.expense.filter(e=>e.cardId===x.id&&(e.date>x.statementDate||(e.date===x.statementDate&&(e.createdAt||0)>(x.statementAt||0))))
}
function cardPaid(x){return sum(x.payments||[])}
function cardBillLeft(x){return round2((+x.balance||0)-cardPaid(x))}          // still to pay on the current bill
function cardUnbilled(x){return round2(sum(cardSpendExpenses(x)))}             // spends that go on the next bill
function cardOutstanding(x){return round2(cardBillLeft(x)+cardUnbilled(x))}   // everything you owe the bank now
function cardDaysUntilDue(x){return daysFromToday(cardStmtDue(x))}
function cardNextBill(x){return x.billingDay?ymd(billAfter(x.billingDay,x.statementDate||today())):null}
function cardNeedsStatement(x){let nb=cardNextBill(x);return!!nb&&today()>=nb}
// Swiping the day after the bill date gives the longest interest-free period
function cardBestSwipe(x){
  if(!x.billingDay)return null;
  let b=billOnOrBefore(x.billingDay,today()),best=new Date(b);best.setDate(best.getDate()+1);
  let nextBill=billAfter(x.billingDay,ymd(best)),due=computeCardDue(x,ymd(nextBill));
  return{day:best.getDate(),days:Math.round((parseYMD(due)-best)/86400000)}
}
function ordinal(n){let s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0])}
function cardFromForm(){
  return{billingDay:val('cardBillingDay')?parseInt(val('cardBillingDay'),10):null,cycleDays:val('cardCycleDays')?parseInt(val('cardCycleDays'),10):null,dueDay:val('cardDueDay')?parseInt(val('cardDueDay'),10):null}
}
function cardFormPreview(){
  let f=cardFromForm(),el=$('cardPreview'),inp=$('cardStmtDue');
  if(!f.dueDay&&!(f.billingDay&&f.cycleDays)){el.innerHTML='';return}
  let ref=f.billingDay?ymd(billOnOrBefore(f.billingDay,today())):today();
  let due=computeCardDue({...f,dueDay:f.dueDay||f.billingDay},ref);
  if(!inp.dataset.touched&&!editingCardId)inp.value=due;
  let best=cardBestSwipe({...f,dueDay:f.dueDay||f.billingDay});
  el.innerHTML=`Current bill${f.billingDay?' (dated '+formatDueDate(ref)+')':''} is due <b>${formatDueDate(due)}</b>${best?` · Best day to swipe: <b>${ordinal(best.day)}</b> (about ${best.days} days interest-free)`:''}`
}
async function addCard(){
  let cardName=val('cardName').trim(),balStr=val('cardBalance'),balance=+balStr,limit=val('cardLimit')?+val('cardLimit'):null,f=cardFromForm();
  if(!cardName||balStr==='')return alert('Enter card name and current bill amount (0 is fine)');
  if(isNaN(balance)||balance<0)return alert('Bill amount must be 0 or more');
  if(!f.cycleDays&&!f.dueDay)return alert('Enter either a Due day, or a Billing day + days until due');
  if(f.dueDay!=null&&(f.dueDay<1||f.dueDay>31))return alert('Due day must be between 1 and 31');
  if(f.billingDay!=null&&(f.billingDay<1||f.billingDay>31))return alert('Billing day must be between 1 and 31');
  if(f.cycleDays&&!f.billingDay)return alert('"Days until due" needs a Billing day to count from');
  if(f.cycleDays!=null&&(f.cycleDays<1||f.cycleDays>60))return alert('Days until due is usually 15–25');
  if(limit!=null&&limit<0)return alert('Credit limit can\'t be negative');
  let existing=editingCardId?state.creditcards.find(c=>c.id===editingCardId):null;
  let obj={...(existing||{}),cardName,balance,limit,...f,dueDay:f.dueDay||f.billingDay,payments:existing?.payments||[]};
  if(!existing){
    // the bill you entered was generated on the last billing date (spends after it are unbilled)
    obj.statementDate=f.billingDay?ymd(billOnOrBefore(f.billingDay,today())):today();
    obj.statementAt=obj.statementDate===today()?Date.now():parseYMD(obj.statementDate).getTime()+86399999
  }
  obj.stmtDueDate=val('cardStmtDue')||computeCardDue(obj,obj.statementDate||today());
  await save('creditcards',obj);resetCardForm();refreshAndSync();toast(existing?'Card updated':'Card saved')
}
function editCard(id){
  let x=state.creditcards.find(r=>r.id===id);if(!x)return;editingCardId=id;
  $('cardName').value=x.cardName;$('cardBalance').value=x.balance;$('cardLimit').value=x.limit||'';$('cardBillingDay').value=x.billingDay||'';$('cardCycleDays').value=x.cycleDays||'';$('cardDueDay').value=x.cycleDays?'':(x.dueDay||'');
  $('cardStmtDue').value=cardStmtDue(x);$('cardStmtDue').dataset.touched='1';
  $('cardSaveBtn').textContent='Update Card';$('cardCancelEdit').classList.remove('hidden');show('cards');window.scrollTo(0,0);cardFormPreview()
}
async function deleteCard(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  if(!await confirmModal('Delete "'+x.cardName+'"? Expenses logged on it stay in your expense history.','Delete',true))return;
  for(let expId of Object.values(x.linkedExpenses||{}))await deleteWithTombstone('expense',+expId);
  await deleteWithTombstone('creditcards',id);refreshAndSync();toast('Card deleted')
}
async function addCardPayment(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  let left=cardBillLeft(x),total=cardOutstanding(x),suggest=left>0?left:total;
  let fields=[{name:'amount',label:'Amount paid',type:'number',step:'0.01',inputmode:'decimal',value:suggest>0?suggest:''},{name:'date',label:'Paid on',type:'date',value:today()}];
  if(meta.accounts.length)fields.push({name:'account',label:'Paid from account',type:'select',options:accountOptions(),value:''});
  let msg=`Bill: ${money(Math.max(left,0))} left${left>0?' — due '+formatDueDate(cardStmtDue(x)):''}`+(cardUnbilled(x)>0?` · Unbilled spends: ${money(cardUnbilled(x))}`:'')+(x.minDue&&left>0?` · Minimum due ${money(x.minDue)}`:'');
  let r=await modal({title:'Payment — '+x.cardName,message:msg,fields,okText:'Save Payment'});
  if(!r)return;
  let amt=parseAmount(r.amount);if(!amt)return alert('Enter a valid positive amount.');
  if(amt>total+0.01&&!await confirmModal(`That's ${money(amt-total)} more than everything you owe on this card (${money(total)}). Record it anyway?`,'Record'))return;
  x.payments=x.payments||[];x.payments.push({date:r.date||today(),amount:amt,account:r.account||''});
  await save('creditcards',x);refreshAndSync();
  toast(cardBillLeft(x)<=0?`✅ ${x.cardName} bill fully paid`:`Payment recorded — ${money(cardBillLeft(x))} left on the bill`)
}
async function newStatement(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  let billDate=x.billingDay?ymd(billOnOrBefore(x.billingDay,today())):today();
  if(x.statementDate&&billDate<=x.statementDate)billDate=today();
  let r=await modal({title:'New bill — '+x.cardName,message:'Copy these from your new card bill (SMS / email / app).',fields:[
    {name:'bal',label:'Total amount due',type:'number',step:'0.01',inputmode:'decimal',value:Math.max(0,cardOutstanding(x))},
    {name:'min',label:'Minimum amount due (optional)',type:'number',step:'0.01',inputmode:'decimal',value:''},
    {name:'billDate',label:'Bill / statement date',type:'date',value:billDate},
    {name:'due',label:'Payment due date',type:'date',value:computeCardDue(x,billDate)}],okText:'Save new bill'});
  if(!r)return;
  let newBal=+r.bal;if(r.bal===''||isNaN(newBal)||newBal<0)return alert('Enter a valid amount (0 or more).');
  let bd=r.billDate||today();
  if(r.due&&r.due<bd)return alert('The due date can\'t be before the bill date.');
  // payments made AFTER the bill date already count towards this new bill; older ones are archived
  let pays=x.payments||[];
  x.pastPayments=[...(x.pastPayments||[]),...pays.filter(p=>p.date<=bd&&p.account)];
  x.payments=pays.filter(p=>p.date>bd);
  x.balance=newBal;x.minDue=parseAmount(r.min)||null;
  x.statementDate=bd;x.statementAt=bd===today()?Date.now():parseYMD(bd).getTime()+86399999;
  x.stmtDueDate=r.due||computeCardDue(x,bd);
  await save('creditcards',x);refreshAndSync();toast('New bill saved — due '+formatDueDate(x.stmtDueDate))
}
// dashboard "pending" rows + badge: card bills due soon or overdue
function pendingCardItems(){
  let out=[];
  for(let x of state.creditcards){
    let left=cardBillLeft(x);if(left<=0)continue;
    let due=cardStmtDue(x),diff=daysFromToday(due);if(diff>REMINDER_LEAD_DAYS)continue;
    out.push({date:due,card:x,left,html:`<div class="row"><b>💳 ${esc(x.cardName)} <span class="muted" style="font-weight:500">card bill</span></b><span>${money(left)}${x.minDue?` <span class="muted" style="font-size:12px">(min ${money(x.minDue)})</span>`:''}</span><span>${formatDueDate(due)}</span><span class="pill ${diff<0?'overdue':''}" style="cursor:pointer" title="Tap to record a payment" onclick="addCardPayment(${x.id})">${remainingLabelFromDays(diff)}</span></div>`})
  }
  return out
}
function renderCards(){
  let cards=state.creditcards.slice().sort((a,b)=>(cardBillLeft(b)>0)-(cardBillLeft(a)>0)||cardStmtDue(a).localeCompare(cardStmtDue(b)));
  $('cardList').innerHTML=cards.map(x=>{
    let left=cardBillLeft(x),unbilled=cardUnbilled(x),out=cardOutstanding(x),paid=cardPaid(x),due=cardStmtDue(x),diff=daysFromToday(due);
    let util=x.limit?Math.round(Math.max(out,0)/x.limit*100):null,utilCls=util==null?'':util>75?'over':util>30?'warn':'';
    let pill=left<=0
      ?`<span class="pill paid">✓ Bill paid</span>`
      :`<span class="pill ${diff<0?'overdue':''}">${formatDueDate(due)}: ${remainingLabelFromDays(diff)}</span>`;
    let alerts=[];
    if(left>0&&diff<0)alerts.push(`<span class="expense">⚠ Overdue — pay at least ${x.minDue?'the minimum '+money(x.minDue):'the minimum due'} today to avoid late fees and a credit-score hit.</span>`);
    if(cardNeedsStatement(x))alerts.push(`<span class="balance">🧾 Your next bill was generated on ${formatDueDate(cardNextBill(x))} — tap <b>New Bill</b> to enter it.</span>`);
    if(util!=null&&util>30)alerts.push(`<span class="muted">Using ${util}% of the limit — keeping it under 30% helps your credit score.</span>`);
    let best=cardBestSwipe(x);
    let hist=(x.payments||[]).length?`<details class="hist"><summary>Payments on this bill (${x.payments.length})</summary><ul>${x.payments.map(p=>`<li>${safeDisplayDate(p.date)} — ${money(p.amount)}${p.account?' from '+esc(accountName(p.account)):''}</li>`).join('')}</ul></details>`:'';
    let spends=cardSpendExpenses(x);
    let spendList=spends.length?`<details class="hist"><summary>Unbilled spends (${spends.length})</summary><ul>${spends.sort((a,b)=>b.date.localeCompare(a.date)).map(e=>`<li>${safeDisplayDate(e.date)} — ${money(e.amount)} ${esc(e.cat||'')}${e.note?' · '+esc(e.note):''}</li>`).join('')}</ul></details>`:'';
    return `<div class="loan-card" id="row-creditcards-${x.id}">
      <div class="loan-head"><div><b style="font-size:16px">💳 ${esc(x.cardName)}</b> <span class="muted" style="font-size:12.5px">${x.billingDay?'Bill on '+ordinal(x.billingDay)+' · ':''}${x.cycleDays?x.cycleDays+' days to pay':'Due on '+ordinal(x.dueDay||1)}</span></div>${pill}</div>
      ${util!=null?`<div style="display:flex;gap:10px;align-items:center;margin-top:10px"><div class="bar ${utilCls}" style="flex:1"><i style="width:${Math.min(util,100)}%"></i></div><span class="muted" style="font-size:12.5px">${util}% of ${money(x.limit)} used</span></div>`:''}
      <div class="loan-stats">
        <div><small>Bill amount</small><b>${money(x.balance)}</b></div>
        <div><small>Paid</small><b class="income">${money(paid)}</b></div>
        <div><small>Left to pay</small><b class="${left>0?'expense':'income'}">${money(Math.max(left,0))}</b>${x.minDue&&left>0?`<span class="muted" style="font-size:11.5px"> min ${money(x.minDue)}</span>`:''}</div>
        <div><small>Unbilled spends</small><b>${money(unbilled)}</b></div>
        <div><small>Total outstanding</small><b class="expense">${money(Math.max(out,0))}</b></div>
        ${x.limit?`<div><small>Available credit</small><b class="income">${money(x.limit-Math.max(out,0))}</b></div>`:''}
      </div>
      ${alerts.length?`<div style="display:grid;gap:4px;font-size:13px;margin-bottom:10px">${alerts.join('')}</div>`:''}
      ${best?`<div class="muted" style="font-size:12.5px;margin-bottom:10px">💡 Best day to swipe: <b>${ordinal(best.day)}</b> — about ${best.days} days interest-free</div>`:''}
      <div class="actions">${out>0?`<button class="btn primary" onclick="addCardPayment(${x.id})">+ Payment</button>`:''}<button class="btn" onclick="newStatement(${x.id})">🧾 New Bill</button><button class="btn" onclick="editCard(${x.id})">Edit</button><button class="btn danger" onclick="deleteCard(${x.id})">Delete</button></div>
      ${hist}${spendList}
    </div>`
  }).join('')||'<p class="muted">💳 No credit cards added yet.</p>';
  let billsDue=state.creditcards.reduce((a,x)=>a+Math.max(0,cardBillLeft(x)),0);
  let totalOut=state.creditcards.reduce((a,x)=>a+Math.max(0,cardOutstanding(x)),0);
  let totalLimit=state.creditcards.reduce((a,x)=>a+(x.limit||0),0);
  $('cardSummary').innerHTML=state.creditcards.length?`<div class="card"><small>Bills to pay</small><div class="amount expense">${money(billsDue)}</div></div><div class="card"><small>Total outstanding</small><div class="amount">${money(totalOut)}</div></div>${totalLimit?`<div class="card"><small>Available credit</small><div class="amount income">${money(totalLimit-totalOut)}</div></div>`:''}`:''
}

// ---------- Accounts ----------
function accountBalance(a){
  let inc=sum(state.income.filter(x=>x.account===a.id));
  let exp=sum(state.expense.filter(x=>x.account===a.id&&x.method!=='Card'));
  let cardPay=0;for(let c of state.creditcards)cardPay+=sum([...(c.payments||[]),...(c.pastPayments||[])].filter(p=>p.account===a.id));
  return(+a.opening||0)+inc-exp-cardPay
}
function addAccount(){
  let name=val('accName').trim();if(!name)return alert('Enter an account name');
  if(meta.accounts.some(a=>a.name.toLowerCase()===name.toLowerCase()))return alert('An account with that name already exists');
  let opening=parseFloat(val('accOpening'))||0;
  meta.accounts.push({id:uid(),name,opening});$('accName').value='';$('accOpening').value='';metaChanged();toast('Account added')
}
async function editAccount(id){
  let a=meta.accounts.find(a=>a.id===id);if(!a)return;
  let r=await modal({title:'Edit account',fields:[{name:'name',label:'Name',value:a.name},{name:'opening',label:'Opening balance',type:'number',step:'0.01',value:a.opening}],okText:'Save'});
  if(!r)return;if(!r.name.trim())return alert('Name can\'t be empty');
  a.name=r.name.trim();a.opening=parseFloat(r.opening)||0;metaChanged()
}
async function deleteAccount(id){
  let a=meta.accounts.find(a=>a.id===id);if(!a)return;
  if(!await confirmModal(`Remove account "${a.name}"? Past entries keep their amounts but will no longer count towards an account.`,'Remove',true))return;
  let idx=meta.accounts.indexOf(a);meta.accounts.splice(idx,1);metaChanged();
  toast('Account removed',{undo:()=>{meta.accounts.splice(idx,0,a);metaChanged()}})
}
function renderAccounts(){
  $('accountList').innerHTML=meta.accounts.map(a=>`<div class="row" style="grid-template-columns:1fr 1fr auto"><b>${esc(a.name)}</b><span class="${accountBalance(a)>=0?'income':'expense'}">${money(accountBalance(a))} <span class="muted" style="font-size:12px">(opening ${money(a.opening)})</span></span><span class="actions"><button class="btn" onclick="editAccount('${a.id}')">Edit</button><button class="btn danger" onclick="deleteAccount('${a.id}')">Remove</button></span></div>`).join('')||'<p class="muted">No accounts yet.</p>';
  $('dashAccountsWrap').classList.toggle('hidden',!meta.accounts.length);
  let total=meta.accounts.reduce((t,a)=>t+accountBalance(a),0);
  $('dashAccounts').innerHTML=meta.accounts.map(a=>{let b=accountBalance(a);return `<div class="insight"><small>${esc(a.name)}</small><b class="${b>=0?'income':'expense'}">${money(b)}</b></div>`}).join('')+(meta.accounts.length>1?`<div class="insight"><small>All accounts</small><b class="balance">${money(total)}</b></div>`:'')
}

// ---------- Recurring entries ----------
function addRecurring(){
  let type=val('rType'),amount=parseAmount(val('rAmount')),day=parseInt(val('rDay'),10),cat=val('rCat');
  if(!amount)return alert('Enter an amount greater than 0');
  if(!(day>=1&&day<=31))return alert('Enter a day of month between 1 and 31');
  let startYM=val('rStart')||thisYM();
  meta.recurring.push({id:uid(),type,amount,cat,method:type==='expense'?val('rMethod'):'',account:val('rMethod')==='Card'&&type==='expense'?'':val('rAccount'),day,startYM,note:val('rNote').trim(),lastYM:addMonths(startYM,-1),active:true});
  ['rAmount','rDay','rNote'].forEach(k=>$(k).value='');
  metaChanged();toast('Recurring entry saved');runRecurring()
}
async function toggleRecurring(id){let r=meta.recurring.find(r=>r.id===id);if(!r)return;r.active=!r.active;if(r.active&&r.lastYM<addMonths(thisYM(),-1))r.lastYM=addMonths(thisYM(),-1);metaChanged();if(r.active)runRecurring()}
async function deleteRecurring(id){
  let idx=meta.recurring.findIndex(r=>r.id===id);if(idx<0)return;
  let r=meta.recurring[idx];
  if(!await confirmModal(`Stop and remove the recurring "${r.note||r.cat}"? Entries it already logged stay.`,'Remove',true))return;
  meta.recurring.splice(idx,1);metaChanged();toast('Recurring entry removed',{undo:()=>{meta.recurring.splice(idx,0,r);metaChanged()}})
}
let recurringRunning=false;
async function runRecurring(){
  if(recurringRunning)return;recurringRunning=true;
  try{
    let ym=thisYM(),todayStr=today(),created=0,changed=false;
    for(let r of meta.recurring){
      if(!r.active)continue;
      let m=r.lastYM?addMonths(r.lastYM,1):r.startYM;
      if(m<r.startYM)m=r.startYM;
      if(monthsBetween(m,ym)>12)m=addMonths(ym,-12); // never back-fill more than a year
      while(monthsBetween(m,ym)>=0){
        let date=dateForDay(m,r.day);
        if(date>todayStr)break;
        let key=r.id+':'+m;
        if(!state[r.type].some(x=>x.recurKey===key)){ // another device may already have logged it
          let obj={date,amount:r.amount,cat:r.cat,note:(r.note||r.cat)+' (recurring)',account:r.account||'',recurKey:key};
          if(r.type==='expense')obj.method=r.method||'';
          await save(r.type,obj);created++
        }
        r.lastYM=m;changed=true;m=addMonths(m,1)
      }
    }
    if(changed)saveMeta();
    if(created){await refreshAndSync();toast(`${created} recurring entr${created===1?'y':'ies'} added`)}
  }finally{recurringRunning=false}
}
function renderRecurList(){
  $('recurList').innerHTML=meta.recurring.map(r=>{
    let next=r.lastYM?addMonths(r.lastYM,1):r.startYM;if(next<r.startYM)next=r.startYM;
    return `<div class="row" style="grid-template-columns:1.4fr 1fr 1fr auto"><span><b>${esc(r.note||r.cat)}</b><br><span class="muted" style="font-size:12px">${r.type==='income'?'Income':'Expense'} · ${esc(r.cat)}${r.method?' · '+esc(r.method):''}${r.account?' · '+esc(accountName(r.account)):''}</span></span><b class="${r.type==='income'?'income':'expense'}">${money(r.amount)}</b><span class="muted">Day ${r.day} monthly<br>${r.active?'Next: '+formatDueDate(dateForDay(next,r.day)):'⏸ Paused'}</span><span class="actions"><button class="btn" onclick="toggleRecurring('${r.id}')">${r.active?'Pause':'Resume'}</button><button class="btn danger" onclick="deleteRecurring('${r.id}')">Remove</button></span></div>`
  }).join('')||'<p class="muted">No recurring entries yet.</p>'
}

// ---------- Categories ----------
function addCategory(type){
  let inp=$(type==='income'?'newIncomeCat':'newExpenseCat'),name=inp.value.trim();if(!name)return;
  let list=type==='income'?meta.incomeCats:meta.expenseCats;
  if(list.some(c=>c.toLowerCase()===name.toLowerCase()))return alert('That category already exists');
  list.push(name);inp.value='';metaChanged();renderBudgetForm()
}
function removeCategory(type,idx){
  let list=type==='income'?meta.incomeCats:meta.expenseCats;
  if(list.length<=1)return alert('Keep at least one category');
  let [name]=list.splice(idx,1);metaChanged();renderBudgetForm();
  toast(`Category "${name}" removed`,{undo:()=>{list.splice(idx,0,name);metaChanged();renderBudgetForm()}})
}
function renderCategoryChips(){
  const chips=(list,type)=>list.map((c,i)=>`<span class="chip">${esc(c)}<button title="Remove" onclick="removeCategory('${type}',${i})">×</button></span>`).join('');
  $('expenseCatChips').innerHTML=chips(meta.expenseCats,'expense');
  $('incomeCatChips').innerHTML=chips(meta.incomeCats,'income')
}
function renderPlan(withBudgetForm=true){renderCategoryChips();renderRecurList();renderAccounts();if(withBudgetForm)renderBudgetForm()}

// ---------- Advances ----------
let editingAdvanceId=null;
function resetAdvanceForm(){['advPerson','advPhone','advAmount','advDueDate','advNote'].forEach(k=>$(k).value='');$('advDirection').value='given';editingAdvanceId=null;$('advSaveBtn').textContent='Save Advance';$('advCancelEdit').classList.add('hidden')}
function advanceRemaining(x){return x.amount-sum(x.payments||[])}
function personKey(n){return String(n||'').trim().toLowerCase()}
async function addAdvance(){
  let person=val('advPerson').trim(),amount=parseAmount(val('advAmount')),direction=val('advDirection');
  if(!person||!amount)return alert('Enter person and an amount greater than 0');
  let existing=editingAdvanceId?state.advances.find(a=>a.id===editingAdvanceId):null;
  // reuse the phone number already saved for this person if none entered
  let phone=val('advPhone').trim()||(state.advances.find(a=>personKey(a.person)===personKey(person)&&a.phone)||{}).phone||'';
  let obj={...(existing||{}),person,phone,amount,direction,dueDate:val('advDueDate'),note:val('advNote').trim(),payments:existing?.payments||[],status:existing?.status||'pending'};
  // re-check settled/pending after an amount change
  let rem=advanceRemaining(obj);
  if(rem<=0&&obj.status!=='settled'){obj.status='settled';obj.settledDate=today()}
  else if(rem>0&&obj.status==='settled'){obj.status='pending';delete obj.settledDate}
  await save('advances',obj);resetAdvanceForm();refreshAndSync();toast(existing?'Advance updated':'Advance saved')
}
function editAdvance(id){
  let x=state.advances.find(r=>r.id===id);if(!x)return;editingAdvanceId=id;
  $('advPerson').value=x.person;$('advPhone').value=x.phone||'';$('advAmount').value=x.amount;$('advDirection').value=x.direction;$('advDueDate').value=normDate(x.dueDate)||'';$('advNote').value=x.note||'';
  $('advSaveBtn').textContent='Update Advance';$('advCancelEdit').classList.remove('hidden');show('advances');window.scrollTo(0,0)
}
async function toggleAdvanceStatus(id){
  let x=state.advances.find(a=>a.id===id);if(!x)return;
  x.payments=x.payments||[];
  if(x.status==='pending'){
    let remaining=advanceRemaining(x);
    if(remaining>0)x.payments.push({date:today(),amount:remaining,auto:true}); // marked so it can be undone
    x.status='settled';x.settledDate=today()
  }else{
    // reopening: drop the automatic "settle" payment so the balance comes back
    let i=x.payments.map(p=>!!p.auto).lastIndexOf(true);
    if(i>=0)x.payments.splice(i,1);
    x.status=advanceRemaining(x)>0?'pending':'settled';
    if(x.status==='pending')delete x.settledDate
  }
  await save('advances',x);await refreshAndSync();
  toast(`${x.person}: ${x.status==='settled'?'marked settled':'reopened'}`,{undo:()=>toggleAdvanceStatus(id)})
}
async function addAdvancePayment(id){
  let x=state.advances.find(a=>a.id===id);if(!x)return;
  let remaining=advanceRemaining(x);
  let r=await modal({title:x.direction==='given'?`${x.person} paid you back`:`You paid ${x.person} back`,message:'Remaining: '+money(remaining),fields:[{name:'amount',label:'Amount',type:'number',step:'0.01',inputmode:'decimal',value:''},{name:'date',label:'Date',type:'date',value:today()}],okText:'Save'});
  if(!r)return;
  let amt=parseAmount(r.amount);if(!amt)return alert('Enter a valid positive amount.');
  if(amt>remaining+0.001&&!await confirmModal(`That's more than the remaining ${money(remaining)}. Record it anyway?`,'Record'))return;
  x.payments=x.payments||[];x.payments.push({date:r.date||today(),amount:amt});
  if(advanceRemaining(x)<=0){x.status='settled';x.settledDate=r.date||today()}
  await save('advances',x);refreshAndSync();toast('Repayment recorded')
}
function waLink(phone,msg){
  let d=String(phone||'').replace(/\D/g,'');if(d.length===10)d='91'+d;
  return 'https://wa.me/'+d+'?text='+encodeURIComponent(msg)
}
function renderAdvances(){
  let people=new Map();
  for(let a of state.advances){
    let k=personKey(a.person);if(!k)continue;
    let p=people.get(k)||{name:a.person.trim(),net:0,phone:'',count:0};
    if(a.phone)p.phone=a.phone;
    if(a.status==='pending'){p.net+=(a.direction==='given'?1:-1)*advanceRemaining(a);p.count++}
    people.set(k,p)
  }
  let list=[...people.values()].filter(p=>Math.abs(p.net)>0.001).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net));
  let owedToYou=list.filter(p=>p.net>0).reduce((a,p)=>a+p.net,0),youOwe=list.filter(p=>p.net<0).reduce((a,p)=>a-p.net,0);
  $('advanceSummary').innerHTML=`<div class="card"><small>Owed to you</small><div class="amount income">${money(owedToYou)}</div></div><div class="card"><small>You owe</small><div class="amount expense">${money(youOwe)}</div></div>`;
  $('advancePeople').innerHTML=list.map(p=>{
    let msg=`Hi ${p.name}, just a gentle reminder about the ${money(p.net)} pending between us. Thanks!`;
    return `<div class="row" style="grid-template-columns:1fr 1.2fr auto"><b>${esc(p.name)}</b><span class="${p.net>0?'income':'expense'}">${p.net>0?'Owes you':'You owe'} ${money(Math.abs(p.net))} <span class="muted" style="font-size:12px">(${p.count} open)</span></span><span class="actions">${p.net>0?`<a class="btn" href="${esc(waLink(p.phone,msg))}" target="_blank" rel="noopener">💬 WhatsApp reminder</a>`:''}</span></div>`
  }).join('')||'<p class="muted">Nobody owes anything right now.</p>';
  let rows=state.advances.slice().sort((a,b)=>(a.status==='settled'?1:0)-(b.status==='settled'?1:0)||b.id-a.id);
  $('advanceList').innerHTML=rows.map(x=>{
    let paidSoFar=sum(x.payments||[]),remaining=advanceRemaining(x);
    let who=x.direction==='given'?'They owe':'You owe';
    let amountLine=x.status==='settled'
      ?`<span class="muted">✓ ${money(x.amount)} ${x.direction==='given'?'lent':'borrowed'} — repaid</span>`
      :paidSoFar>0?`${who} ${money(remaining)} <span class="muted" style="font-weight:400">(${money(paidSoFar)} of ${money(x.amount)} repaid)</span>`
      :`${who} ${money(x.amount)}`;
    let hist=(x.payments||[]).length?`<details class="hist"><summary>History (${x.payments.length})</summary><ul><li>${safeDisplayDate(x.createdAt?ymd(new Date(x.createdAt)):'')||'—'} — ${x.direction==='given'?'lent':'borrowed'} ${money(x.amount)}</li>${x.payments.map(p=>`<li>${safeDisplayDate(p.date)} — repaid ${money(p.amount)}${p.auto?' (marked settled)':''}</li>`).join('')}</ul></details>`:'';
    let due=x.dueDate&&x.status==='pending'?`Repay by ${safeDisplayDate(x.dueDate)}`:'';
    return `<div class="row" id="row-advances-${x.id}"><span><b>${esc(x.person)}</b></span><b class="${x.direction==='given'?'income':'expense'}">${amountLine}</b><span>${due} ${x.note?esc(x.note):''}${hist}</span><span class="pill ${x.status==='settled'?'paid':''}" style="cursor:pointer" title="Tap to ${x.status==='settled'?'reopen':'mark fully settled'}" onclick="toggleAdvanceStatus(${x.id})">${x.status==='settled'?'✓ Settled'+(x.settledDate?' on '+safeDisplayDate(x.settledDate):''):'⏳ Pending'}</span><span class="actions">${x.status==='pending'?`<button class="btn" onclick="addAdvancePayment(${x.id})">+ Repayment</button>`:''}<button class="btn" onclick="editAdvance(${x.id})">Edit</button><button class="btn danger" onclick="del('advances',${x.id},'Advance')">Delete</button></span></div>`
  }).join('')||'<p class="muted">🤝 No advances yet — track money lent or borrowed here.</p>'
}

// ---------- Notes ----------
let editingNoteId=null;
function resetNoteForm(){$('noteTitle').value='';$('noteContent').value='';editingNoteId=null;$('noteSaveBtn').textContent='Save Note';$('noteCancelEdit').classList.add('hidden')}
async function addNote(){
  let title=val('noteTitle').trim();if(!title)return alert('Enter a title');
  let existing=editingNoteId?state.notes.find(n=>n.id===editingNoteId):null;
  let obj={...(existing||{}),title,content:val('noteContent'),date:today()};
  await save('notes',obj);resetNoteForm();refreshAndSync();toast(existing?'Note updated':'Note saved')
}
function editNote(id){let x=state.notes.find(r=>r.id===id);if(!x)return;editingNoteId=id;$('noteTitle').value=x.title;$('noteContent').value=x.content||'';$('noteSaveBtn').textContent='Update Note';$('noteCancelEdit').classList.remove('hidden');show('notes');window.scrollTo(0,0)}
function renderNotes(){
  let rows=state.notes.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)||b.id-a.id);
  $('noteList').innerHTML=rows.map(x=>`<div class="row" id="row-notes-${x.id}" style="grid-template-columns:1fr auto"><span><b>${esc(x.title)}</b><br><span class="muted">${esc((x.content||'').slice(0,120))}</span></span><span class="actions"><button class="btn" onclick="editNote(${x.id})">Edit</button><button class="btn danger" onclick="del('notes',${x.id},'Note')">Delete</button></span></div>`).join('')||'<p class="muted">📝 No notes yet.</p>'
}

// ---------- Documents ----------
let documentUrlCache=new Map();
function getDocumentUrl(doc){if(!doc.blob)return'';if(!documentUrlCache.has(doc.id))documentUrlCache.set(doc.id,URL.createObjectURL(doc.blob));return documentUrlCache.get(doc.id)}
function revokeDocumentUrl(id){if(documentUrlCache.has(id)){URL.revokeObjectURL(documentUrlCache.get(id));documentUrlCache.delete(id)}}
function revokeAllDocumentUrls(){for(let url of documentUrlCache.values())URL.revokeObjectURL(url);documentUrlCache.clear()}
async function addDocument(){
  let fileInput=$('docFile'),file=fileInput.files[0];
  if(!file)return alert('Choose a file first');
  if(file.size>20*1024*1024)return alert('File too large for on-device storage (20MB limit).');
  let title=val('docTitle').trim()||file.name;
  await save('documents',{title,tags:val('docTags'),fileName:file.name,fileType:file.type,blob:file,dateAdded:today()});
  fileInput.value='';$('docTitle').value='';$('docTags').value='';
  await refresh();toast('Document saved')
}
function renderDocuments(){
  let rows=state.documents.slice().sort((a,b)=>b.id-a.id);
  $('documentList').innerHTML=rows.map(x=>{let url=getDocumentUrl(x);return `<div class="row" id="row-documents-${x.id}" style="grid-template-columns:1fr auto"><span><b>${esc(x.title)}</b><br><span class="muted">${esc(x.tags||'')} · ${esc(x.dateAdded)}</span></span><span class="actions">${url?`<a class="btn" href="${url}" target="_blank" rel="noopener" download="${esc(x.fileName||x.title)}">Open</a>`:''}<button class="btn danger" onclick="del('documents',${x.id},'Document')">Delete</button></span></div>`}).join('')||'<p class="muted">📄 No documents yet.</p>'
}

// ---------- Dashboard ----------
function render(){
  populateSelects();
  let period=val('dashPeriod')||'month',ym=thisYM();
  let inPeriod=x=>period==='all'||x.date.startsWith(ym);
  let inc=sum(state.income.filter(inPeriod)),exp=sum(state.expense.filter(inPeriod));
  let monthName=new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  $('dIncomeLabel').textContent=period==='all'?'Total Income':'Income';
  $('dExpenseLabel').textContent=period==='all'?'Total Expense':'Expense';
  $('dBalanceLabel').textContent=period==='all'?'Balance (all time)':'Saved this month';
  $('dashPeriodNote').textContent=period==='all'?'Showing all-time totals':'Showing '+monthName;
  $('dIncome').textContent=money(inc);$('dExpense').textContent=money(exp);$('dBalance').textContent=money(inc-exp);
  renderExpenseFastForm();renderIncomeList();renderExpenseList();renderDues();renderCards();renderAdvances();renderLoans();renderNotes();renderDocuments();renderDashInsights();renderDashBudgets();renderPlan(false);refreshBackupBanner();
  if(val('globalSearch').trim())runGlobalSearch();
  if(!$('reports').classList.contains('hidden'))report()
}
function daysElapsedInMonth(ym){let curYM=thisYM();if(ym===curYM)return new Date().getDate();if(ym<curYM)return daysInMonth(ym);return 0}
function renderDashInsights(){
  let now=new Date(),ym=thisYM(),lastYM=addMonths(ym,-1);
  let thisInc=sum(state.income.filter(x=>x.date.startsWith(ym)));
  let thisExp=sum(state.expense.filter(x=>x.date.startsWith(ym)));
  // compare against the SAME number of days last month, not the whole month
  let cutoff=lastYM+'-'+pad(Math.min(now.getDate(),daysInMonth(lastYM)));
  let lastExpSame=sum(state.expense.filter(x=>x.date.startsWith(lastYM)&&x.date<=cutoff));
  let savingsRate=thisInc>0?((thisInc-thisExp)/thisInc*100):0;
  let spendChange=lastExpSame>0?((thisExp-lastExpSame)/lastExpSame*100):null;
  let dailyAvg=thisExp/now.getDate();
  let netAdv=0;for(let a of state.advances)if(a.status==='pending')netAdv+=(a.direction==='given'?1:-1)*advanceRemaining(a);
  let totalBalance=sum(state.income)-sum(state.expense);
  let delta=spendChange==null?'':`<span class="delta ${spendChange<=0?'up':'down'}">${spendChange>0?'▲':spendChange<0?'▼':'='} ${Math.abs(spendChange).toFixed(0)}%</span>`;
  $('dashInsights').innerHTML=`
    <div class="insight"><small>Savings rate (this month)</small><b class="${savingsRate>=0?'income':'expense'}">${savingsRate.toFixed(0)}%</b></div>
    <div class="insight"><small>Spend vs same days last month</small><b>${money(thisExp)}</b>${delta}</div>
    <div class="insight"><small>Daily avg spend</small><b>${money(dailyAvg)}</b></div>
    <div class="insight"><small>Net worth (incl. advances)</small><b class="${totalBalance+netAdv>=0?'income':'expense'}">${money(totalBalance+netAdv)}</b></div>${loanInsightTile()}`
}
function show(id){
  document.querySelectorAll('main>section').forEach(x=>x.classList.toggle('hidden',x.id!==id));
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
  updateBottomNav(id);
  if(window.matchMedia&&matchMedia('(max-width:700px)').matches)window.scrollTo(0,0);
  if(id==='reports')report();
  if(id==='plan')renderPlan(true)
}

// ---------- Reports + charts ----------
function lastNMonths(n){let out=[];for(let i=n-1;i>=0;i--)out.push(addMonths(thisYM(),-i));return out}
function report(){
  let m=val('month')||thisYM();
  let inc=sum(state.income.filter(x=>x.date.startsWith(m))),exp=sum(state.expense.filter(x=>x.date.startsWith(m)));
  $('reportBox').innerHTML=`<div><small>Income</small><br><b class="income">${money(inc)}</b></div><div><small>Expense</small><br><b class="expense">${money(exp)}</b></div><div><small>Balance</small><br><b class="balance">${money(inc-exp)}</b></div>`;
  let cats={};state.expense.filter(x=>x.date.startsWith(m)).forEach(x=>cats[x.cat||'Others']=(cats[x.cat||'Others']||0)+x.amount);
  $('catBox').innerHTML='<h3>Expense by Category</h3>'+(Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{let lim=+meta.budgets[k]||0;return `<div class="row" style="grid-template-columns:1fr 1fr 1fr"><b>${esc(k)}</b><span>${money(v)}</span><span class="muted">${lim?`budget ${money(lim)} · ${Math.round(v/lim*100)}%`:''}</span></div>`}).join('')||'<p class="muted">No expenses for this month.</p>');
  renderReportInsights(m,inc,exp,cats);
  drawCategoryChart(cats);drawTrendChart();drawSavingsChart()
}
function csvEscape(v){let s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function downloadBlob(blob,name){let url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)}
function exportReportCSV(){
  let m=val('month')||thisYM(),rows=[];
  state.income.filter(x=>x.date.startsWith(m)).forEach(x=>rows.push([x.date,'Income',x.cat||x.source||'',x.amount,accountName(x.account),x.note||'']));
  state.expense.filter(x=>x.date.startsWith(m)).forEach(x=>rows.push([x.date,'Expense',x.cat||'',x.amount,x.cardId?cardName(x.cardId):accountName(x.account),[x.method,x.note].filter(Boolean).join(' - ')]));
  rows.sort((a,b)=>a[0].localeCompare(b[0]));
  let lines=[['Date','Type','Category','Amount','Account/Card','Details'],...rows].map(r=>r.map(csvEscape).join(',')).join('\r\n');
  downloadBlob(new Blob([lines],{type:'text/csv;charset=utf-8'}),'daily-tracker-report-'+m+'.csv')
}
function exportReportPDF(){window.print()}
function renderReportInsights(m,inc,exp,cats){
  let savingsRate=inc>0?((inc-exp)/inc*100):0;
  let top=Object.entries(cats).sort((a,b)=>b[1]-a[1])[0];
  let elapsed=daysElapsedInMonth(m),dailyAvg=elapsed>0?exp/elapsed:0,isCurrent=m===thisYM();
  let projected=isCurrent?dailyAvg*daysInMonth(m):exp;
  $('reportInsights').innerHTML=`
    <div class="insight"><small>Savings rate</small><b class="${savingsRate>=0?'income':'expense'}">${savingsRate.toFixed(0)}%</b></div>
    <div class="insight"><small>Top category</small><b>${top?esc(top[0]):'—'}</b>${top?`<span class="delta muted">${money(top[1])}</span>`:''}</div>
    <div class="insight"><small>Daily avg spend</small><b>${money(dailyAvg)}</b></div>
    <div class="insight"><small>${isCurrent?'Projected month-end spend':'Total spend'}</small><b>${money(projected)}</b></div>`
}
function setupCanvas(canvas){let ratio=window.devicePixelRatio||1;let w=canvas.clientWidth||600,h=canvas.clientHeight||220;canvas.width=w*ratio;canvas.height=h*ratio;let ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);return{ctx,w,h}}
function drawCategoryChart(cats){
  let canvas=$('catChart');if(!canvas)return;
  let entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  let{ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  if(!entries.length){ctx.fillStyle='#667085';ctx.font='13px Arial';ctx.fillText('No expenses this month',10,h/2);return}
  let max=Math.max(...entries.map(e=>e[1]))*1.15;
  let padL=40,padB=34,padT=10,padR=10,chartW=w-padL-padR,chartH=h-padT-padB,gap=chartW/entries.length,barW=gap*0.6;
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  entries.forEach(([label,v],i)=>{let x=padL+i*gap+(gap-barW)/2,barH=chartH*(v/max);ctx.fillStyle='#dc2626';ctx.fillRect(x,padT+chartH-barH,barW,barH);ctx.fillStyle='#667085';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(String(label).slice(0,10),x+barW/2,padT+chartH+14)});
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(max),padL-6,padT+10);ctx.fillText('0',padL-6,padT+chartH)
}
function drawTrendChart(){
  let canvas=$('trendChart');if(!canvas)return;
  let months=lastNMonths(6);
  let incVals=months.map(m=>sum(state.income.filter(x=>x.date.startsWith(m)))),expVals=months.map(m=>sum(state.expense.filter(x=>x.date.startsWith(m))));
  let{ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  let max=Math.max(...incVals,...expVals,1)*1.15,padL=45,padB=30,padT=18,padR=10,chartW=w-padL-padR,chartH=h-padT-padB,n=months.length,gap=chartW/n,barW=gap*0.32;
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  months.forEach((mo,i)=>{let xBase=padL+i*gap+gap*0.18,hA=chartH*(incVals[i]/max),hB=chartH*(expVals[i]/max);ctx.fillStyle='#15803d';ctx.fillRect(xBase,padT+chartH-hA,barW,hA);ctx.fillStyle='#dc2626';ctx.fillRect(xBase+barW+4,padT+chartH-hB,barW,hB);ctx.fillStyle='#667085';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(mo.slice(5)+'/'+mo.slice(2,4),xBase+barW+2,padT+chartH+14)});
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(max),padL-6,padT+10);ctx.fillText('0',padL-6,padT+chartH);
  ctx.textAlign='left';ctx.fillStyle='#15803d';ctx.fillRect(padL,0,10,10);ctx.fillStyle='#667085';ctx.font='11px Arial';ctx.fillText('Income',padL+14,9);
  ctx.fillStyle='#dc2626';ctx.fillRect(padL+80,0,10,10);ctx.fillStyle='#667085';ctx.fillText('Expense',padL+94,9)
}
function drawSavingsChart(){
  let canvas=$('savingsChart');if(!canvas)return;
  let months=lastNMonths(6);
  let rates=months.map(m=>{let inc=sum(state.income.filter(x=>x.date.startsWith(m))),exp=sum(state.expense.filter(x=>x.date.startsWith(m)));return inc>0?((inc-exp)/inc*100):0});
  let{ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  let maxV=Math.max(...rates,0)*1.15||10,minV=Math.min(...rates,0)*1.15;
  let padL=45,padB=30,padT=15,padR=14,chartW=w-padL-padR,chartH=h-padT-padB,range=(maxV-minV)||1,n=months.length,gap=chartW/Math.max(n-1,1);
  let yFor=v=>padT+chartH-((v-minV)/range)*chartH,zeroY=yFor(0);
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  if(minV<0){ctx.strokeStyle='#e2e8f0';ctx.beginPath();ctx.moveTo(padL,zeroY);ctx.lineTo(padL+chartW,zeroY);ctx.stroke()}
  ctx.strokeStyle='#2563eb';ctx.lineWidth=2;ctx.beginPath();months.forEach((mo,i)=>{let x=padL+i*gap,y=yFor(rates[i]);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();ctx.lineWidth=1;
  months.forEach((mo,i)=>{let x=padL+i*gap,y=yFor(rates[i]);ctx.fillStyle=rates[i]>=0?'#15803d':'#dc2626';ctx.beginPath();ctx.arc(x,y,3.5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#667085';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(mo.slice(5)+'/'+mo.slice(2,4),x,padT+chartH+14)});
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(maxV)+'%',padL-6,padT+10);ctx.fillText(Math.round(minV)+'%',padL-6,padT+chartH)
}
let resizeTimer=null;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!$('reports').classList.contains('hidden'))report()},200)});

// ---------- Notifications ----------
function notifStatusText(){if(!('Notification'in window))return'Not supported in this browser';return{granted:'Enabled',denied:'Blocked — allow notifications for this app in your browser/OS settings',default:'Not enabled yet'}[Notification.permission]}
function refreshNotifStatus(){$('notifStatus').textContent='Status: '+notifStatusText()}
async function enableNotifications(){
  if(!('Notification'in window))return alert('Notifications are not supported in this browser.');
  let perm=await Notification.requestPermission();refreshNotifStatus();
  if(perm==='granted'){checkDueNotifications();tryPeriodicSync();toast('Reminders enabled')}
  else if(perm==='denied')alert('Notifications are blocked. Enable them from your browser or system app settings to get reminders.')
}
function loadNotified(){try{return JSON.parse(localStorage.getItem('notifiedDues')||'{}')}catch(e){return{}}}
function saveNotified(n){
  let cutoff=ymd(new Date(Date.now()-40*86400000));
  for(let k of Object.keys(n))if(n[k]<cutoff)delete n[k]; // don't grow forever
  try{localStorage.setItem('notifiedDues',JSON.stringify(n))}catch(e){}
}
async function checkDueNotifications(){
  if(!('Notification'in window)||Notification.permission!=='granted'||!('serviceWorker'in navigator))return;
  let reg=await navigator.serviceWorker.ready,todayStr=today(),notified=loadNotified();
  for(let o of pendingDueOccurrences()){
    let diff=daysFromToday(o.dateStr);if(diff>REMINDER_LEAD_DAYS)continue;
    let key='due-'+o.due.id+'-'+o.dateStr;
    if(notified[key]===todayStr)continue;
    reg.showNotification((diff<0?'Overdue: ':'Due reminder: ')+o.due.name,{body:money(o.due.amount)+' — '+(diff<0?'was ':'')+'due '+formatDueDate(o.dateStr)+'.',tag:key,icon:'icon-192.png',badge:'icon-192.png'});
    notified[key]=todayStr
  }
  for(let it of pendingCardItems()){
    let diff=daysFromToday(it.date),key='card-'+it.card.id+'-'+it.date;
    if(notified[key]===todayStr)continue;
    reg.showNotification((diff<0?'Card bill overdue: ':'Card bill due: ')+it.card.cardName,{body:money(it.left)+(it.card.minDue?' (min '+money(it.card.minDue)+')':'')+' — '+(diff<0?'was ':'')+'due '+formatDueDate(it.date)+'.',tag:key,icon:'icon-192.png',badge:'icon-192.png'});
    notified[key]=todayStr
  }
  for(let it of pendingEmiItems()){
    let diff=daysFromToday(it.date);if(diff>REMINDER_LEAD_DAYS)continue;
    let key='emi-'+it.loan.id+'-'+it.date;if(notified[key]===todayStr)continue;
    reg.showNotification((diff<0?'EMI overdue: ':'EMI due: ')+it.loan.name,{body:money(it.row.emi)+' — EMI #'+it.row.no+' '+(diff<0?'was ':'')+'due '+formatDueDate(it.date)+'.',tag:key,icon:'icon-192.png',badge:'icon-192.png'});
    notified[key]=todayStr
  }
  saveNotified(notified)
}
async function requestPersistence(){if(!(navigator.storage&&navigator.storage.persist))return;if(!await navigator.storage.persisted())await navigator.storage.persist();refreshPersistStatus()}
async function refreshPersistStatus(){
  let el=$('persistStatus');
  if(!(navigator.storage&&navigator.storage.persisted)){el.textContent='Storage protection: not supported in this browser';return}
  el.textContent='Storage protection: '+(await navigator.storage.persisted()?'On — the browser won\'t auto-clear this data under storage pressure':'Off — ask the browser to protect this data')
}
function refreshBackupBanner(){
  let last=localStorage.getItem('lastBackup');
  let days=last?Math.floor((Date.now()-new Date(last).getTime())/86400000):null;
  $('lastBackupText').textContent=last?('Last backup: '+days+(days===1?' day':' days')+' ago'):'You have never exported a backup';
  $('backupBanner').classList.toggle('hidden',!(last===null||days>=7))
}
async function tryPeriodicSync(){
  try{
    let reg=await navigator.serviceWorker.ready;
    if('periodicSync'in reg){let status=await navigator.permissions.query({name:'periodic-background-sync'});if(status.state==='granted')await reg.periodicSync.register('check-dues',{minInterval:12*60*60*1000})}
  }catch(e){}
}

// ---------- App lock (PIN) ----------
async function sha256(s){let b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function getPin(){try{return JSON.parse(localStorage.getItem('dtPin')||'null')}catch(e){return null}}
async function verifyPin(p){let s=getPin();if(!s)return true;return await sha256(s.salt+p)===s.hash}
function refreshPinUI(){let on=!!getPin();$('pinStatus').textContent='PIN: '+(on?'On':'Off');$('pinSetBtn').textContent=on?'Change PIN':'Set PIN';$('pinRemoveBtn').classList.toggle('hidden',!on)}
async function setPin(){
  if(!(window.crypto&&crypto.subtle))return alert('App lock needs the app to be opened over https.');
  let fields=[{name:'p1',label:'New PIN (4–8 digits)',type:'password',inputmode:'numeric'},{name:'p2',label:'Confirm new PIN',type:'password',inputmode:'numeric'}];
  if(getPin())fields.unshift({name:'old',label:'Current PIN',type:'password',inputmode:'numeric'});
  let r=await modal({title:getPin()?'Change PIN':'Set app PIN',fields,okText:'Save PIN'});if(!r)return;
  if(getPin()&&!await verifyPin(r.old))return alert('Current PIN is wrong.');
  if(!/^\d{4,8}$/.test(r.p1))return alert('PIN must be 4 to 8 digits.');
  if(r.p1!==r.p2)return alert('The two PINs don\'t match.');
  let salt=uid();localStorage.setItem('dtPin',JSON.stringify({salt,hash:await sha256(salt+r.p1)}));
  refreshPinUI();toast('PIN saved — the app will ask for it on open')
}
async function removePin(){
  let r=await modal({title:'Remove PIN',fields:[{name:'old',label:'Current PIN',type:'password',inputmode:'numeric'}],okText:'Remove',danger:true});if(!r)return;
  if(!await verifyPin(r.old))return alert('Wrong PIN.');
  localStorage.removeItem('dtPin');refreshPinUI();toast('PIN removed')
}
let lockFails=0,hiddenAt=0;
function isLocked(){return!$('lock').classList.contains('hidden')}
function lockApp(){if(!getPin())return;document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('lock').classList.remove('hidden');$('lockPin').value='';$('lockMsg').textContent='';setTimeout(()=>$('lockPin').focus(),50)}
async function unlock(){
  let inp=$('lockPin');
  if(await verifyPin(inp.value)){$('lock').classList.add('hidden');lockFails=0;inp.value='';if(pendingAction){let f=pendingAction;pendingAction=null;f()}return}
  lockFails++;inp.value='';
  if(lockFails>=5){inp.disabled=true;$('lockMsg').textContent='Too many attempts — wait 30 seconds';setTimeout(()=>{inp.disabled=false;lockFails=0;$('lockMsg').textContent='';inp.focus()},30000)}
  else $('lockMsg').textContent='Wrong PIN'
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)hiddenAt=Date.now();
  else if(hiddenAt&&Date.now()-hiddenAt>60000)lockApp()
});
lockApp(); // before any data is rendered

// ---------- Backup ----------
function blobToBase64(blob){return new Promise((res,rej)=>{if(!(blob instanceof Blob))return res(null);let r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)})}
function base64ToBlob(dataUrl){return fetch(dataUrl).then(r=>r.blob())}
async function exportData(){
  let exportState={...state,meta,exportedAt:new Date().toISOString(),backupVersion:2};
  exportState.documents=await Promise.all(state.documents.map(async d=>{try{return{...d,blob:d.blob?await blobToBase64(d.blob):null}}catch(e){return{...d,blob:null}}}));
  downloadBlob(new Blob([JSON.stringify(exportState)],{type:'application/json'}),'daily-tracker-backup-'+today()+'.json');
  localStorage.setItem('lastBackup',new Date().toISOString());refreshBackupBanner();toast('Backup downloaded')
}
async function importData(e){
  let input=e.target,f=input.files[0];input.value=''; // allow picking the same file again later
  if(!f)return;
  let data;try{data=JSON.parse(await f.text())}catch(err){return alert('That file isn\'t a valid backup (could not read JSON).')}
  if(!data||!Array.isArray(data.income)||!Array.isArray(data.expense)||!Array.isArray(data.dues))return alert('Invalid backup');
  if(!await confirmModal('Replace ALL data on this device with this backup?','Restore',true))return;
  // prepare documents first so a bad file can't leave you half-restored
  let docs=[];for(let x of (data.documents||[])){let y={...x};try{if(y.blob)y.blob=await base64ToBlob(y.blob)}catch(err){y.blob=null}docs.push(y)}
  revokeAllDocumentUrls();await clearStores();
  for(let k of Object.keys(state)){
    for(let x of (k==='documents'?docs:(data[k]||[]))){
      // keep original ids so links (due→expense, expense→card) stay intact
      let y={...x};if(y.id==null||typeof y.id!=='number')delete y.id;
      await putExact(k,y)
    }
  }
  if(data.meta){meta=mergeMeta(data.meta);saveMeta(false)}
  await refresh();toast('Backup restored')
}
function clearStores(){return Promise.all(Object.keys(state).map(k=>new Promise(r=>{let q=db.transaction(k,'readwrite').objectStore(k).clear();q.onsuccess=()=>r();q.onerror=()=>r()})))}
async function clearAll(){if(await confirmModal('Delete all finance data from this device?','Delete everything',true)){revokeAllDocumentUrls();await clearStores();refresh()}}

let installEvent;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e});
async function installApp(){if(installEvent){installEvent.prompt();installEvent=null}else alert(/iphone|ipad/i.test(navigator.userAgent)?'In Safari, tap Share → Add to Home Screen.':'Use your browser menu → Install app / Add to Home screen.')}

// ---------- App updates ----------
let updatingApp=false,swReg=null;
function showUpdateBar(){$('updateBar').classList.remove('hidden')}
function applyUpdate(){updatingApp=true;if(swReg&&swReg.waiting)swReg.waiting.postMessage({type:'SKIP_WAITING'});else location.reload()}
async function setupServiceWorker(){
  if(!('serviceWorker'in navigator))return;
  try{
    swReg=await navigator.serviceWorker.register('sw.js');
    if(swReg.waiting&&navigator.serviceWorker.controller)showUpdateBar();
    swReg.addEventListener('updatefound',()=>{let nw=swReg.installing;if(!nw)return;nw.addEventListener('statechange',()=>{if(nw.state==='installed'&&navigator.serviceWorker.controller)showUpdateBar()})});
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updatingApp)location.reload()});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)swReg.update().catch(()=>{})});
    if('Notification'in window&&Notification.permission==='granted'){checkDueNotifications();tryPeriodicSync()}
  }catch(e){}
}

// ========== Google Sheets two-way sync (via Apps Script Web App) ==========
const DEFAULT_SCRIPT_URL='https://script.google.com/macros/s/AKfycbyZwnxmg4AYQpC8Hu9Ln1mO_x_0JFus4CARV9Pn5u9OLcjeKBhM00grHAp_1Qd8FeEC5A/exec';
const DEFAULT_SYNC_TOKEN='dt-b574d5d72a89ae2b';
function getScriptUrl(){return localStorage.getItem('gsScriptUrl')||DEFAULT_SCRIPT_URL}
function setScriptUrl(v){localStorage.setItem('gsScriptUrl',v)}
function getSyncToken(){return localStorage.getItem('gsSyncToken')||DEFAULT_SYNC_TOKEN}
function setSyncToken(v){localStorage.setItem('gsSyncToken',v)}
function updateSyncStatus(msg){$('syncStatus').textContent=msg}
function saveScriptConfig(){
  let url=val('gsScriptUrlInput').trim(),token=val('gsSyncTokenInput').trim();
  if(!url)return alert('Paste your Apps Script Web App URL first.');
  if(!token)return alert('Set a secret token (any word/phrase — must match what you put in the script).');
  setScriptUrl(url);setSyncToken(token);updateSyncStatus('Saved. Tap "Sync Now" whenever you want to sync.')
}
// Column layout per Sheet tab. New columns are only ever appended at the end,
// so older rows still read correctly.
const SHEET_TABS={
  Income:['id','date','amount','cat','note','updatedAt','account','recurKey','createdAt'],
  Expense:['id','date','amount','cat','method','note','updatedAt','account','cardId','recurKey','createdAt'],
  Dues:['id','name','amount','days','paidDates','linkedExpenses','updatedAt','paymentDates','frequency','startYM'],
  CreditCards:['id','cardName','balance','limit','dueDay','paidDates','linkedExpenses','paymentDates','updatedAt','billingDay','payments','cycleDays','statementDate','statementAt','pastPayments','stmtDueDate','minDue'],
  Advances:['id','person','amount','direction','status','dueDate','note','updatedAt','settledDate','payments','phone'],
  Notes:['id','title','content','date','updatedAt'],
  Loans:['id','name','lender','principal','rate','tenureMonths','startDate','emi','paidBefore','payments','updatedAt'],
  Tombstones:['id','store','recordId','deletedAt'],
  Meta:['key','json','updatedAt']
};
const J=(v,d)=>{try{return v?JSON.parse(v):d}catch(e){return d}};
const splitList=v=>String(v||'').split(',').map(s=>s.trim()).filter(Boolean).map(normDate);
function rowId(v){if(v===''||v==null)return undefined;let n=+v;return isNaN(n)?undefined:n}
// A missing updatedAt now counts as "oldest", so a half-filled Sheet row never overwrites your local edits.
const TS=v=>+v||0;
function rowsToObjects(tab,rows){
  return (rows||[]).map(r=>{
    let id=rowId(r[0]);
    if(tab==='Income')return{id,date:normDate(r[1])||today(),amount:+r[2]||0,cat:r[3]||'Other',note:r[4]||'',updatedAt:TS(r[5]),account:r[6]||'',recurKey:r[7]||'',createdAt:TS(r[8])};
    if(tab==='Expense')return{id,date:normDate(r[1])||today(),amount:+r[2]||0,cat:r[3]||'Others',method:r[4]||'',note:r[5]||'',updatedAt:TS(r[6]),account:r[7]||'',cardId:rowId(r[8])??null,recurKey:r[9]||'',createdAt:TS(r[10])};
    if(tab==='Dues')return{id,name:r[1]||'Untitled',amount:+r[2]||0,days:parseDays(r[3]||''),paidDates:splitList(r[4]),linkedExpenses:J(r[5],{}),updatedAt:TS(r[6]),paymentDates:J(r[7],{}),frequency:FREQ_INTERVAL[r[8]]?r[8]:'monthly',startYM:normYM(r[9])||undefined};
    if(tab==='CreditCards')return{id,cardName:r[1]||'Untitled',balance:+r[2]||0,limit:r[3]?+r[3]:null,dueDay:+r[4]||1,paidDates:splitList(r[5]),linkedExpenses:J(r[6],{}),paymentDates:J(r[7],{}),updatedAt:TS(r[8]),billingDay:r[9]?+r[9]:null,payments:J(r[10],[]),cycleDays:r[11]?+r[11]:null,statementDate:normDate(r[12])||undefined,statementAt:TS(r[13]),pastPayments:J(r[14],[]),stmtDueDate:normDate(r[15])||undefined,minDue:r[16]?+r[16]:undefined};
    if(tab==='Advances')return{id,person:String(r[1]||''),amount:+r[2]||0,direction:r[3]==='taken'?'taken':'given',status:r[4]==='settled'?'settled':'pending',dueDate:normDate(r[5]),note:r[6]||'',updatedAt:TS(r[7]),settledDate:normDate(r[8])||undefined,payments:J(r[9],[]),phone:String(r[10]||'')};
    if(tab==='Loans')return{id,name:String(r[1]||'Loan'),lender:String(r[2]||''),principal:+r[3]||0,rate:+r[4]||0,tenureMonths:+r[5]||1,startDate:normDate(r[6])||today(),emi:r[7]?+r[7]:null,paidBefore:+r[8]||0,payments:J(r[9],[]),updatedAt:TS(r[10])};
    if(tab==='Tombstones')return{id:String(r[0]||''),store:r[1]||'',recordId:rowId(r[2]),deletedAt:TS(r[3])};
    return{id,title:r[1]||'Untitled',content:r[2]||'',date:normDate(r[3])||today(),updatedAt:TS(r[4])}
  })
}
function objectToRow(tab,x){
  if(tab==='Income')return[x.id,x.date,x.amount,x.cat||x.source||'',x.note||'',x.updatedAt||0,x.account||'',x.recurKey||'',x.createdAt||''];
  if(tab==='Expense')return[x.id,x.date,x.amount,x.cat||'',x.method||'',x.note||'',x.updatedAt||0,x.account||'',x.cardId||'',x.recurKey||'',x.createdAt||''];
  if(tab==='Dues')return[x.id,x.name,x.amount,(x.days||[]).join(','),(x.paidDates||[]).join(','),JSON.stringify(x.linkedExpenses||{}),x.updatedAt||0,JSON.stringify(x.paymentDates||{}),x.frequency||'monthly',x.startYM||''];
  if(tab==='CreditCards')return[x.id,x.cardName,x.balance,x.limit||'',x.dueDay,(x.paidDates||[]).join(','),JSON.stringify(x.linkedExpenses||{}),JSON.stringify(x.paymentDates||{}),x.updatedAt||0,x.billingDay||'',JSON.stringify(x.payments||[]),x.cycleDays||'',x.statementDate||'',x.statementAt||'',JSON.stringify(x.pastPayments||[]),x.stmtDueDate||'',x.minDue||''];
  if(tab==='Advances')return[x.id,x.person,x.amount,x.direction,x.status,x.dueDate||'',x.note||'',x.updatedAt||0,x.settledDate||'',JSON.stringify(x.payments||[]),x.phone||''];
  if(tab==='Loans')return[x.id,x.name,x.lender||'',x.principal,x.rate,x.tenureMonths,x.startDate,x.emi||'',x.paidBefore||0,JSON.stringify(x.payments||[]),x.updatedAt||0];
  if(tab==='Tombstones')return[x.id,x.store,x.recordId,x.deletedAt];
  return[x.id,x.title,x.content||'',x.date,x.updatedAt||0]
}
// Newer updatedAt wins on shared ids; one-sided records are added. Deletions are handled via tombstones.
function mergeRecords(localArr,remoteArr){
  let result=localArr.map(r=>Object.assign({},r));
  let byId=new Map(result.filter(r=>r.id!=null).map(r=>[r.id,r]));
  for(let r of remoteArr){
    if(r.id!=null&&byId.has(r.id)){
      let existing=byId.get(r.id);
      if((r.updatedAt||0)>(existing.updatedAt||0)){
        // don't let an older Sheet layout (missing new columns) wipe fields it doesn't know about
        for(let k of Object.keys(r))if(r[k]===undefined)delete r[k];
        Object.assign(existing,r,{id:existing.id})
      }
    }else if(r.id!=null){let obj=Object.assign({},r);result.push(obj);byId.set(obj.id,obj)}
    else{let obj=Object.assign({},r);delete obj.id;result.push(obj)}
  }
  return result
}
async function scriptGetAll(){
  let res=await fetch(getScriptUrl()+'?all=1&token='+encodeURIComponent(getSyncToken()));
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();if(data.error)throw new Error('Script error: '+data.error);
  return data.tabs||{}
}
async function scriptPostAll(tabsData){
  let res=await fetch(getScriptUrl(),{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({token:getSyncToken(),all:true,tabs:tabsData})});
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();if(data.error)throw new Error('Script error: '+data.error)
}
async function withRetry(fn,label){try{return await fn()}catch(e){updateSyncStatus(label+' failed once, retrying…');await new Promise(r=>setTimeout(r,800));return await fn()}}
const TAB_STORE_MAP={Income:'income',Expense:'expense',Dues:'dues',CreditCards:'creditcards',Advances:'advances',Loans:'loans',Notes:'notes'};
let isSyncing=false,syncQueued=false;
async function syncNow(){
  if(isSyncing){syncQueued=true;return}
  isSyncing=true;
  let btn=$('syncNowBtn');if(btn)btn.disabled=true;
  try{
    if(!getScriptUrl()||!getSyncToken())throw new Error('Paste your Apps Script URL and token above first, then Save.');
    updateSyncStatus('Syncing…');
    while(refreshing)await refreshing;
    let remoteTabs=await withRetry(()=>scriptGetAll(),'Fetching');

    // Merge delete history from all devices; prune very old tombstones so the Sheet doesn't grow forever.
    let remoteTombstones=rowsToObjects('Tombstones',remoteTabs.Tombstones);
    let localTombstones=await all('tombstones');
    let tombMap=new Map(),pruneBefore=Date.now()-TOMBSTONE_TTL_DAYS*86400000;
    for(let t of[...localTombstones,...remoteTombstones]){if(!t.id)continue;let ex=tombMap.get(t.id);if(!ex||t.deletedAt>ex.deletedAt)tombMap.set(t.id,t)}
    for(let t of[...tombMap.values()]){if(t.deletedAt<pruneBefore){tombMap.delete(t.id);await deleteRecord('tombstones',t.id)}else await putExact('tombstones',t)}

    // Loans only sync once the Sheet has a "Loans" tab (older Apps Scripts may not accept new tabs).
    let syncTabs=Object.keys(TAB_STORE_MAP).filter(t=>t!=='Loans'||Object.prototype.hasOwnProperty.call(remoteTabs,'Loans'));
    for(let tab of syncTabs){
      let storeName=TAB_STORE_MAP[tab];
      let local=await all(storeName); // fresh read, so an edit made a moment ago isn't overwritten with a stale copy
      let merged=mergeRecords(local,rowsToObjects(tab,remoteTabs[tab]));
      merged=merged.filter(obj=>{let tomb=obj.id!=null?tombMap.get(storeName+':'+obj.id):null;return!tomb||(obj.updatedAt||0)>tomb.deletedAt});
      let keepIds=new Set(merged.filter(o=>o.id!=null).map(o=>o.id));
      for(let ex of local)if(ex.id!=null&&!keepIds.has(ex.id))await deleteRecord(storeName,ex.id);
      let localById=new Map(local.map(r=>[r.id,r]));
      for(let obj of merged){
        let before=obj.id!=null?localById.get(obj.id):null;
        if(before&&(before.updatedAt||0)>=(obj.updatedAt||0)&&JSON.stringify(before)===JSON.stringify(obj))continue; // unchanged
        let newId=await putExact(storeName,obj);if(!obj.id)obj.id=newId
      }
      state[storeName]=await all(storeName)
    }

    // Plan data (budgets, recurring, accounts, categories) — only if the Sheet has a "Meta" tab.
    let hasMeta=Object.prototype.hasOwnProperty.call(remoteTabs,'Meta');
    if(hasMeta){
      let row=(remoteTabs.Meta||[]).find(r=>r[0]==='meta');
      if(row&&TS(row[2])>(meta.updatedAt||0)){let m=J(row[1],null);if(m){meta=mergeMeta(m);meta.updatedAt=TS(row[2]);saveMeta(false)}}
    }

    let outgoing={};
    for(let tab of syncTabs)outgoing[tab]=state[TAB_STORE_MAP[tab]].map(x=>objectToRow(tab,x));
    outgoing.Tombstones=[...tombMap.values()].map(x=>objectToRow('Tombstones',x));
    if(hasMeta)outgoing.Meta=[['meta',JSON.stringify(meta),meta.updatedAt||0]];
    await withRetry(()=>scriptPostAll(outgoing),'Saving');
    localStorage.setItem('lastSync',new Date().toISOString());
    await refresh();
    updateSyncStatus('Synced ✓ — just now')
  }catch(e){updateSyncStatus('Sync failed: '+e.message)}
  finally{
    isSyncing=false;if(btn)btn.disabled=false;
    if(syncQueued){syncQueued=false;syncNow()}
  }
}
function refreshSyncUI(){
  let urlEl=$('gsScriptUrlInput');if(!urlEl.value)urlEl.value=getScriptUrl();
  let tokenEl=$('gsSyncTokenInput');if(!tokenEl.value)tokenEl.value=getSyncToken();
  let last=localStorage.getItem('lastSync');
  updateSyncStatus(last?('Last synced: '+new Date(last).toLocaleString()):'Not synced yet')
}

// ---------- Loans / EMI tracker ----------
let editingLoanId=null;
const openDetails=new Set(); // keeps schedule / what-if panels open across re-renders
const simState={};           // per-loan what-if inputs + last result
function rememberDetails(el){el.open?openDetails.add(el.dataset.dkey):openDetails.delete(el.dataset.dkey)}
function dOpen(key){return openDetails.has(key)?' open':''}
function round2(n){return Math.round(n*100)/100}
function fmtYM(ym){let[y,m]=ym.split('-').map(Number);return new Date(y,m-1,1).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}
function emiFormula(P,r,n){if(n<=0)return P;if(!r)return P/n;let f=Math.pow(1+r,n);return P*r*f/(f-1)}
function loanRate(L){return(+L.rate||0)/1200}
function installmentDate(L,i){let s=L.startDate||today();return dateForDay(addMonths(s.slice(0,7),i),+s.slice(8,10)||1)}
function tenureLabel(n){let y=Math.floor(n/12),m=n%12;return[y?y+' yr':'',m?m+' mo':''].filter(Boolean).join(' ')||'0 mo'}
// Full amortisation with the payments you've actually recorded:
// - EMIs are counted in order (paidBefore + recorded EMI payments)
// - prepayments cut the principal on their date; "emi" mode then recalculates a lower EMI
function loanCalc(L){
  let r=loanRate(L),n=Math.max(1,+L.tenureMonths||1),P=+L.principal||0;
  let emi=+L.emi||emiFormula(P,r,n);
  let pays=L.payments||[];
  let pre=pays.filter(p=>p.type==='prepay').slice().sort((a,b)=>a.date.localeCompare(b.date));
  let paidCount=(+L.paidBefore||0)+pays.filter(p=>p.type==='emi').length;
  let bal=P,pi=0,rows=[],interestPaid=0,principalPaid=0,totalInterest=0,k=0,todayStr=today();
  for(let i=0;bal>0.005&&i<n+600;i++){
    let date=installmentDate(L,i);
    while(pi<pre.length&&pre[pi].date<date&&bal>0.005){
      let a=Math.min(+pre[pi].amount||0,bal);bal-=a;principalPaid+=a;
      rows.push({prepay:true,date:pre[pi].date,amount:a,balance:bal});
      if(pre[pi].mode==='emi'&&bal>0.005)emi=emiFormula(bal,r,Math.max(1,n-i));
      pi++
    }
    if(bal<=0.005)break;
    let interest=bal*r,prin=Math.min(Math.max(emi-interest,0),bal);
    if(prin<=0&&i>=n)break; // EMI doesn't even cover interest — stop instead of looping forever
    bal-=prin;totalInterest+=interest;
    let paid=k<paidCount;k++;
    if(paid){interestPaid+=interest;principalPaid+=prin}
    rows.push({no:k,date,emi:interest+prin,principal:prin,interest,balance:Math.max(bal,0),paid})
  }
  let inst=rows.filter(x=>!x.prepay),next=inst.find(x=>!x.paid)||null;
  return{emi,rows,inst,next,interestPaid,principalPaid,totalInterest,
    outstanding:Math.max(0,P-principalPaid),paidCount:Math.min(paidCount,inst.length),total:inst.length,
    overdue:inst.filter(x=>!x.paid&&x.date<todayStr),closing:inst.length?inst[inst.length-1].date:'',
    done:!next,tooSmall:P>0&&emi<=P*r}
}
function loanFromForm(){
  let tenure=parseInt(val('loanTenure'),10)||0;
  if(val('loanTenureUnit')==='years')tenure*=12;
  return{name:val('loanName').trim(),lender:val('loanLender').trim(),principal:parseAmount(val('loanPrincipal')),rate:parseFloat(val('loanRate')),
    tenureMonths:tenure,startDate:val('loanStart')||today(),emi:parseAmount(val('loanEmi'))||null}
}
function autoPaidBefore(L){let t=today(),c=loanCalc({...L,paidBefore:0,payments:[]});return c.inst.filter(x=>x.date<t).length}
function loanPreview(){
  let L=loanFromForm(),el=$('loanPreview');
  if(!L.principal||!(L.tenureMonths>0)||isNaN(L.rate)){el.textContent='';return}
  let c=loanCalc({...L,paidBefore:0,payments:[]});
  if(c.tooSmall){el.innerHTML='<span class="expense">⚠ That EMI doesn\'t cover the monthly interest — check the numbers.</span>';return}
  let pb=val('loanPaidBefore')===''&&!editingLoanId?autoPaidBefore(L):null;
  el.innerHTML=`EMI <b>${money(round2(c.emi))}</b> · total interest <b>${money(round2(c.totalInterest))}</b> · total payable <b>${money(round2(L.principal+c.totalInterest))}</b> · last EMI ${c.closing?formatDueDate(c.closing)+' '+c.closing.slice(0,4):'—'}${pb?` · <span class="balance">${pb} EMI${pb===1?'':'s'} before today will be marked paid</span>`:''}`
}
function resetLoanForm(){['loanName','loanLender','loanPrincipal','loanRate','loanTenure','loanEmi','loanPaidBefore'].forEach(k=>$(k).value='');$('loanTenureUnit').value='months';$('loanStart').value=today();editingLoanId=null;$('loanSaveBtn').textContent='Save Loan';$('loanCancelEdit').classList.add('hidden');$('loanPreview').textContent=''}
async function addLoan(){
  let f=loanFromForm();
  if(!f.name)return alert('Enter a loan name');
  if(!f.principal)return alert('Enter the loan amount');
  if(isNaN(f.rate)||f.rate<0||f.rate>60)return alert('Enter the yearly interest rate (e.g. 9.5)');
  if(!(f.tenureMonths>0&&f.tenureMonths<=600))return alert('Enter the tenure (up to 50 years)');
  if(loanCalc({...f,paidBefore:0,payments:[]}).tooSmall)return alert('That EMI doesn\'t cover the monthly interest — please check the EMI amount.');
  let existing=editingLoanId?state.loans.find(l=>l.id===editingLoanId):null;
  let pbStr=val('loanPaidBefore');
  let paidBefore=pbStr!==''?Math.max(0,parseInt(pbStr,10)||0):existing?(existing.paidBefore||0):autoPaidBefore(f);
  let obj={...(existing||{}),...f,paidBefore,payments:existing?.payments||[]};
  await save('loans',obj);resetLoanForm();refreshAndSync();toast(existing?'Loan updated':'Loan saved')
}
function editLoan(id){
  let L=state.loans.find(l=>l.id===id);if(!L)return;editingLoanId=id;
  $('loanName').value=L.name;$('loanLender').value=L.lender||'';$('loanPrincipal').value=L.principal;$('loanRate').value=L.rate;
  let yrs=L.tenureMonths%12===0;$('loanTenure').value=yrs?L.tenureMonths/12:L.tenureMonths;$('loanTenureUnit').value=yrs?'years':'months';
  $('loanStart').value=L.startDate;$('loanEmi').value=L.emi||'';$('loanPaidBefore').value=L.paidBefore||0;
  $('loanSaveBtn').textContent='Update Loan';$('loanCancelEdit').classList.remove('hidden');show('loans');window.scrollTo(0,0);loanPreview()
}
async function deleteLoan(id){
  let L=state.loans.find(l=>l.id===id);if(!L)return;
  if(!await confirmModal(`Delete "${L.name}"? EMIs already added to Expenses stay there.`,'Delete',true))return;
  await deleteWithTombstone('loans',id);refreshAndSync();toast('Loan deleted')
}
function ensureExpenseCat(c){if(!meta.expenseCats.includes(c)){meta.expenseCats.push(c);saveMeta()}}
async function payEmi(id){
  let L=state.loans.find(l=>l.id===id);if(!L)return;
  let c=loanCalc(L);if(!c.next)return toast('This loan is fully repaid 🎉');
  let fields=[{name:'amount',label:`EMI #${c.next.no} — due ${formatDueDate(c.next.date)} ${c.next.date.slice(0,4)}`,type:'number',step:'0.01',inputmode:'decimal',value:round2(c.next.emi)},{name:'date',label:'Paid on',type:'date',value:today()},{name:'log',label:'Also add it to Expenses?',type:'select',options:[{value:'yes',label:'Yes — category "EMI"'},{value:'no',label:'No'}],value:'yes'}];
  if(meta.accounts.length)fields.push({name:'account',label:'Paid from account',type:'select',options:accountOptions(),value:''});
  let r=await modal({title:'Pay EMI — '+L.name,fields,okText:'Mark EMI paid'});if(!r)return;
  let amt=parseAmount(r.amount);if(!amt)return alert('Enter the EMI amount paid');
  let pay={id:uid(),type:'emi',no:c.next.no,date:r.date||today(),amount:amt};
  if(r.log==='yes'){ensureExpenseCat('EMI');pay.expenseId=await save('expense',{date:pay.date,amount:amt,cat:'EMI',method:r.account?'Bank':'',account:r.account||'',note:`${L.name} EMI #${c.next.no}`})}
  L.payments=[...(L.payments||[]),pay];
  await save('loans',L);await refreshAndSync();
  toast(`EMI #${c.next.no} paid for ${L.name}`,{undo:()=>removeLoanPayment(id,pay.id,true)})
}
async function prepayLoan(id,preset){
  let L=state.loans.find(l=>l.id===id);if(!L)return;
  let c=loanCalc(L);if(c.done)return toast('This loan is fully repaid 🎉');
  let r=await modal({title:'Part-prepayment — '+L.name,message:'Outstanding principal: '+money(round2(c.outstanding)),fields:[
    {name:'amount',label:'Extra amount paid',type:'number',step:'0.01',inputmode:'decimal',value:preset||''},
    {name:'date',label:'Paid on',type:'date',value:today()},
    {name:'mode',label:'What did the bank do?',type:'select',options:[{value:'tenure',label:'Kept EMI, loan ends sooner'},{value:'emi',label:'Kept tenure, EMI reduced'}],value:'tenure'},
    {name:'log',label:'Also add it to Expenses?',type:'select',options:[{value:'no',label:'No'},{value:'yes',label:'Yes — category "EMI"'}],value:'no'}],okText:'Record prepayment'});
  if(!r)return;
  let amt=parseAmount(r.amount);if(!amt)return alert('Enter the amount');
  if(amt>c.outstanding+0.01&&!await confirmModal(`That's more than the outstanding ${money(round2(c.outstanding))}. Record it anyway?`,'Record'))return;
  let pay={id:uid(),type:'prepay',date:r.date||today(),amount:amt,mode:r.mode==='emi'?'emi':'tenure'};
  if(r.log==='yes'){ensureExpenseCat('EMI');pay.expenseId=await save('expense',{date:pay.date,amount:amt,cat:'EMI',method:'Bank',note:`${L.name} prepayment`})}
  L.payments=[...(L.payments||[]),pay];
  await save('loans',L);delete simState[id];await refreshAndSync();
  toast(`Prepayment of ${money(amt)} recorded`,{undo:()=>removeLoanPayment(id,pay.id,true)})
}
async function removeLoanPayment(loanId,payId,silent){
  let L=state.loans.find(l=>l.id===loanId);if(!L)return;
  let p=(L.payments||[]).find(x=>x.id===payId);if(!p)return;
  if(!silent&&!await confirmModal(`Remove this ${p.type==='emi'?'EMI':'prepayment'} of ${money(p.amount)}?${p.expenseId?' Its matching expense is removed too.':''}`,'Remove',true))return;
  L.payments=L.payments.filter(x=>x.id!==payId);
  if(p.expenseId)await deleteWithTombstone('expense',p.expenseId);
  await save('loans',L);await refreshAndSync();if(!silent)toast('Payment removed')
}
// month-by-month payoff from the current balance
function simulatePayoff(bal,r,emi,extra){
  let m=0,int=0;
  while(bal>0.005&&m<1200){let i=bal*r;let p=Math.min(emi+extra-i,bal);if(p<=0)return{months:Infinity,interest:Infinity};int+=i;bal-=p;m++}
  return{months:m,interest:int}
}
function simInput(id,field,v){simState[id]=simState[id]||{};simState[id][field]=v}
function runLoanSim(id){
  let L=state.loans.find(l=>l.id===id);if(!L)return;
  let c=loanCalc(L),s=simState[id]||{},lump=parseFloat(s.lump)||0,extra=parseFloat(s.extra)||0,out;
  let r=loanRate(L),bal=c.outstanding,firstYM=c.next?c.next.date.slice(0,7):thisYM();
  if(c.done)out='<p class="muted">This loan is already repaid.</p>';
  else if(!lump&&!extra)out='<p class="muted">Enter a one-time amount, an extra amount every month, or both.</p>';
  else if(lump>=bal-0.005){
    let base=simulatePayoff(bal,r,c.emi,0);
    out=`<div class="opt">Paying <b>${money(round2(bal))}</b> closes the loan now and saves <b class="income">${money(round2(base.interest))}</b> of future interest (${base.months} EMIs).</div>`
  }else{
    let base=simulatePayoff(bal,r,c.emi,0),a=simulatePayoff(bal-lump,r,c.emi,extra);
    let saved=base.interest-a.interest,mSaved=base.months-a.months;
    out=`<div class="opt"><b>Keep the same EMI${extra?` + ${money(extra)} extra each month`:''}</b><br>Interest saved: <b class="income">${money(round2(saved))}</b><br>Loan closes <b>${mSaved} month${mSaved===1?'':'s'} earlier</b> (${tenureLabel(mSaved)}) — ${fmtYM(addMonths(firstYM,a.months-1))} instead of ${fmtYM(addMonths(firstYM,base.months-1))}</div>`;
    if(lump){
      let newEmi=emiFormula(bal-lump,r,base.months),intB=newEmi*base.months-(bal-lump);
      out+=`<div class="opt"><b>Or keep the same end date (${fmtYM(addMonths(firstYM,base.months-1))})</b><br>EMI drops to <b>${money(round2(newEmi))}</b> (from ${money(round2(c.emi))})<br>Interest saved: <b class="income">${money(round2(base.interest-intB))}</b></div><p class="muted" style="margin:8px 0 0">Keeping the EMI saves more interest. Ask your bank which option they apply.</p><button class="btn" style="margin-top:8px" onclick="prepayLoan(${id},${lump})">I've paid this — record ₹${lump.toLocaleString('en-IN')} prepayment</button>`
    }
  }
  simState[id]={...s,out};
  let el=$('sim-out-'+id);if(el)el.innerHTML=out
}
function loanStatusPill(c){
  if(c.done)return'<span class="pill paid">✓ Fully repaid</span>';
  if(c.overdue.length)return`<span class="pill overdue">⚠️ ${c.overdue.length} EMI${c.overdue.length===1?'':'s'} overdue</span>`;
  let d=daysFromToday(c.next.date);
  return`<span class="pill ${d<=REMINDER_LEAD_DAYS?'':'paid'}">Next EMI ${formatDueDate(c.next.date)}: ${remainingLabelFromDays(d)}</span>`
}
function renderLoans(){
  let totalOut=0,monthly=0,intPaid=0;
  $('loanList').innerHTML=state.loans.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(L=>{
    let c=loanCalc(L),P=+L.principal||0,pct=P?Math.min(100,c.principalPaid/P*100):0;
    totalOut+=c.outstanding;intPaid+=c.interestPaid;if(!c.done)monthly+=c.emi;
    let sched=c.rows.map(x=>x.prepay
      ?`<tr class="pre"><td>Prepaid</td><td>${formatDueDate(x.date)} ${x.date.slice(2,4)}</td><td>${money(round2(x.amount))}</td><td>${money(round2(x.amount))}</td><td>—</td><td>${money(round2(x.balance))}</td><td>✓</td></tr>`
      :`<tr class="${x.paid?'paid':c.next&&x.no===c.next.no?'next':''}"><td>${x.no}</td><td>${formatDueDate(x.date)} ${x.date.slice(2,4)}</td><td>${money(round2(x.emi))}</td><td>${money(round2(x.principal))}</td><td>${money(round2(x.interest))}</td><td>${money(round2(x.balance))}</td><td>${x.paid?'✓':x.date<today()?'⚠️':''}</td></tr>`).join('');
    let s=simState[L.id]||{};
    let hist=(L.payments||[]).slice().sort((a,b)=>b.date.localeCompare(a.date)).map(p=>`<li>${safeDisplayDate(p.date)} — ${p.type==='emi'?'EMI #'+(p.no||'')+' ':'Prepayment '}${money(p.amount)}${p.mode==='emi'?' (EMI reduced)':''} <button class="btn" style="padding:2px 8px;min-height:0;font-size:11.5px" onclick="removeLoanPayment(${L.id},'${p.id}')">remove</button></li>`).join('');
    return `<div class="loan-card" id="row-loans-${L.id}">
      <div class="loan-head"><div><b style="font-size:16px">${esc(L.name)}</b> <span class="muted" style="font-size:12.5px">${L.lender?esc(L.lender)+' · ':''}${+L.rate}% · ${tenureLabel(+L.tenureMonths)} · ${money(P)}</span></div><div><b style="font-size:17px">${money(round2(c.emi))}</b><span class="muted">/month</span></div></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><div class="bar" style="flex:1"><i style="width:${pct.toFixed(1)}%"></i></div><span class="muted" style="font-size:12.5px">${pct.toFixed(0)}% repaid</span></div>
      <div class="loan-stats">
        <div><small>Outstanding</small><b class="expense">${money(round2(c.outstanding))}</b></div>
        <div><small>Principal repaid</small><b class="income">${money(round2(c.principalPaid))}</b></div>
        <div><small>Interest paid so far</small><b>${money(round2(c.interestPaid))}</b></div>
        <div><small>Total interest (loan)</small><b>${money(round2(c.totalInterest))}</b></div>
        <div><small>EMIs paid</small><b>${c.paidCount} / ${c.total}</b></div>
        <div><small>Last EMI</small><b>${c.closing?fmtYM(c.closing.slice(0,7)):'—'}</b></div>
      </div>
      <div class="actions" style="align-items:center">${loanStatusPill(c)}${c.done?'':`<button class="btn primary" onclick="payEmi(${L.id})">Pay EMI</button><button class="btn" onclick="prepayLoan(${L.id})">Prepay</button>`}<button class="btn" onclick="editLoan(${L.id})">Edit</button><button class="btn danger" onclick="deleteLoan(${L.id})">Delete</button></div>
      ${c.done?'':`<details class="hist" data-dkey="sim-${L.id}" ontoggle="rememberDetails(this)"${dOpen('sim-'+L.id)}><summary>💡 What if I pay extra?</summary><div class="sim"><input class="inp" type="number" min="0" step="1000" inputmode="decimal" placeholder="One-time amount now" value="${esc(s.lump||'')}" oninput="simInput(${L.id},'lump',this.value)"><input class="inp" type="number" min="0" step="500" inputmode="decimal" placeholder="Extra every month" value="${esc(s.extra||'')}" oninput="simInput(${L.id},'extra',this.value)"><button class="btn primary" onclick="runLoanSim(${L.id})">Calculate</button></div><div class="sim-out" id="sim-out-${L.id}">${s.out||''}</div></details>`}
      <details class="hist" data-dkey="sched-${L.id}" ontoggle="rememberDetails(this)"${dOpen('sched-'+L.id)}><summary>📋 EMI schedule (${c.total} EMIs)</summary><div class="sched-wrap"><table class="sched"><thead><tr><th>#</th><th>Date</th><th>EMI</th><th>Principal</th><th>Interest</th><th>Balance</th><th></th></tr></thead><tbody>${sched}</tbody></table></div></details>
      ${hist?`<details class="hist" data-dkey="hist-${L.id}" ontoggle="rememberDetails(this)"${dOpen('hist-'+L.id)}><summary>🧾 Payments recorded (${L.payments.length})${L.paidBefore?` · ${L.paidBefore} paid before tracking`:''}</summary><ul>${hist}</ul></details>`:''}
    </div>`
  }).join('')||'<p class="muted">📉 No loans yet — add a home, car, bike, personal or gold loan above.</p>';
  $('loanSummary').innerHTML=state.loans.length?`<div class="card"><small>Total Outstanding</small><div class="amount expense">${money(round2(totalOut))}</div></div><div class="card"><small>Monthly EMIs</small><div class="amount">${money(round2(monthly))}</div></div><div class="card"><small>Interest Paid So Far</small><div class="amount balance">${money(round2(intPaid))}</div></div>`:''
}
// unpaid EMIs that are overdue or due within the reminder window (for dashboard + notifications)
function pendingEmiItems(){
  let out=[];
  for(let L of state.loans){
    let c=loanCalc(L);
    for(let row of c.inst){
      if(row.paid)continue;
      let diff=daysFromToday(row.date);if(diff>REMINDER_LEAD_DAYS)break;
      out.push({date:row.date,loan:L,row,html:`<div class="row"><b>📉 ${esc(L.name)} <span class="muted" style="font-weight:500">EMI #${row.no}</span></b><span>${money(round2(row.emi))}</span><span>${formatDueDate(row.date)}</span><span class="pill ${diff<0?'overdue':''}" style="cursor:pointer" title="Tap to pay" onclick="payEmi(${L.id})">${remainingLabelFromDays(diff)}</span></div>`})
    }
  }
  return out
}
function loanInsightTile(){
  if(!state.loans.length)return'';
  let out=0,monthly=0;for(let L of state.loans){let c=loanCalc(L);out+=c.outstanding;if(!c.done)monthly+=c.emi}
  return`<div class="insight" style="cursor:pointer" onclick="show('loans')"><small>Loans outstanding</small><b class="expense">${money(round2(out))}</b><span class="delta muted">EMI ${money(round2(monthly))}/mo</span></div>`
}

// ---------- Search across everything ----------
let searchResults=[],searchTimer=null;
function onGlobalSearchInput(){clearTimeout(searchTimer);searchTimer=setTimeout(runGlobalSearch,150)}
function searchIndex(){
  let o=[];
  state.income.forEach(x=>o.push({icon:'💰',type:'Income',tab:'income',row:'row-income-'+x.id,title:(x.cat||x.source||'Income')+(x.note?' — '+x.note:''),sub:formatDueDate(x.date)+' '+x.date.slice(0,4)+(x.account?' · '+accountName(x.account):''),amount:x.amount,cls:'income',date:x.date,hay:[x.date,x.cat,x.source,x.note,x.amount,accountName(x.account),'income']}));
  state.expense.forEach(x=>o.push({icon:'💸',type:'Expense',tab:'expense',row:'row-expense-'+x.id,title:(x.cat||'Expense')+(x.note?' — '+x.note:''),sub:formatDueDate(x.date)+' '+x.date.slice(0,4)+(x.method?' · '+x.method:'')+(x.cardId?' · '+cardName(x.cardId):x.account?' · '+accountName(x.account):''),amount:x.amount,cls:'expense',date:x.date,hay:[x.date,x.cat,x.note,x.method,x.amount,accountName(x.account),x.cardId?cardName(x.cardId):'','expense']}));
  state.dues.forEach(x=>o.push({icon:'📅',type:'Due',tab:'dues',row:'row-dues-'+x.id,title:x.name,sub:(FREQ_LABEL[x.frequency]||'Monthly')+' · day '+(x.days||[]).join(', '),amount:x.amount,cls:'',hay:[x.name,x.amount,'due bill']}));
  state.creditcards.forEach(x=>o.push({icon:'💳',type:'Credit card',tab:'cards',row:'row-creditcards-'+x.id,title:x.cardName,sub:'Outstanding '+money(cardOutstanding(x)),amount:cardOutstanding(x),cls:'expense',hay:[x.cardName,'card credit']}));
  state.loans.forEach(x=>{let c=loanCalc(x);o.push({icon:'📉',type:'Loan',tab:'loans',row:'row-loans-'+x.id,title:x.name,sub:(x.lender?x.lender+' · ':'')+'EMI '+money(round2(c.emi))+' · outstanding '+money(round2(c.outstanding)),amount:x.principal,cls:'',hay:[x.name,x.lender,x.principal,round2(c.emi),Math.round(c.emi),'loan emi']})});
  state.advances.forEach(x=>o.push({icon:'🤝',type:'Advance',tab:'advances',row:'row-advances-'+x.id,title:x.person+(x.note?' — '+x.note:''),sub:(x.direction==='given'?'Lent':'Borrowed')+' · '+(x.status==='settled'?'Settled':'Pending '+money(advanceRemaining(x))),amount:x.amount,cls:x.direction==='given'?'income':'expense',date:x.createdAt?ymd(new Date(x.createdAt)):'',hay:[x.person,x.note,x.phone,x.amount,'advance']}));
  state.notes.forEach(x=>o.push({icon:'📝',type:'Note',tab:'notes',row:'row-notes-'+x.id,title:x.title,sub:(x.content||'').slice(0,80),cls:'',date:x.date,hay:[x.title,x.content,'note']}));
  state.documents.forEach(x=>o.push({icon:'📄',type:'Document',tab:'documents',row:'row-documents-'+x.id,title:x.title,sub:[x.tags,x.fileName].filter(Boolean).join(' · '),cls:'',date:x.dateAdded,hay:[x.title,x.tags,x.fileName,'document']}));
  return o
}
function runGlobalSearch(){
  let q=val('globalSearch').trim().toLowerCase(),panel=$('searchPanel');
  if(!q){panel.classList.add('hidden');searchResults=[];return}
  let tokens=q.split(/\s+/).map(t=>t.replace(/[₹,]/g,'')).filter(Boolean);
  searchResults=searchIndex().filter(o=>{
    let h=(o.hay.map(v=>String(v??'')).join(' ')+' '+(o.date?formatDueDate(o.date):'')).toLowerCase();
    return tokens.every(t=>h.includes(t))
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,60);
  panel.classList.remove('hidden');
  panel.innerHTML=`<div class="head-row"><b>${searchResults.length?searchResults.length+(searchResults.length===60?'+':'')+' result'+(searchResults.length===1?'':'s'):'No results'} for "${esc(val('globalSearch').trim())}"</b><button class="btn" onclick="clearGlobalSearch()">Close</button></div>`+
    searchResults.map((o,i)=>`<div class="row sr" onclick="searchGo(${i})"><span class="ico">${o.icon}</span><span><b>${esc(o.title)}</b><br><span class="muted" style="font-size:12.5px">${esc(o.type)} · ${esc(o.sub)}</span></span>${o.amount!=null?`<b class="${o.cls}">${money(o.amount)}</b>`:'<span></span>'}</div>`).join('')
}
function clearGlobalSearch(){$('globalSearch').value='';runGlobalSearch()}
function searchGo(i){
  let o=searchResults[i];if(!o)return;
  clearGlobalSearch();
  if(o.tab==='income')clearFilters('i');if(o.tab==='expense')clearFilters('e');
  show(o.tab);setTimeout(()=>focusRow(o.row),80)
}
function focusRow(id){let el=$(id);if(!el)return;el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),2600)}
document.addEventListener('keydown',e=>{
  let t=e.target,typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable);
  if(e.key==='/'&&!typing&&!isLocked()){e.preventDefault();$('globalSearch').focus()}
  else if(e.key==='Escape'&&t===$('globalSearch'))clearGlobalSearch()
});

// ---------- Quick add (floating + button & home-screen shortcuts) ----------
let qa={type:'expense',cat:'',method:'Cash'},qaCatList=[];
const QA_METHODS=['Cash','UPI','Bank','Card'];
function qaCats(type){
  let list=type==='income'?meta.incomeCats:meta.expenseCats,cutoff=ymd(new Date(Date.now()-90*86400000)),freq={};
  state[type].forEach(x=>{if(x.date>=cutoff){let c=x.cat||x.source;freq[c]=(freq[c]||0)+1}});
  return list.slice().sort((a,b)=>(freq[b]||0)-(freq[a]||0)) // most-used first
}
function openQuickAdd(type,opts={}){
  if(isLocked())return;
  let dlg=$('quickAdd');if(dlg.open)return;
  qa={type:type||'expense',cat:'',method:localStorage.getItem('qaMethod')||'Cash'};
  $('qaAmount').value='';$('qaNote').value='';$('qaDate').value=today();
  fillSelect($('qaCard'),state.creditcards.map(c=>({value:String(c.id),label:c.cardName})),state.creditcards.length?'— Which card? —':'No cards added');
  $('qaCard').value=localStorage.getItem('qaCard')||'';
  renderQuickAdd();$('qaAccount').value=localStorage.getItem('qaAccount-'+qa.type)||'';
  $('qaSmsInfo').classList.add('hidden');$('qaSmsText').value='';qaShowSmsBox(false);
  dlg.showModal();
  if(opts.smsText)applySms(opts.smsText);else if(opts.paste)pasteSms();else setTimeout(()=>$('qaAmount').focus(),60)
}
function setQaType(t){qa.type=t;qa.cat='';renderQuickAdd();$('qaAccount').value=localStorage.getItem('qaAccount-'+t)||''}
function qaPick(kind,i){if(kind==='cat')qa.cat=qaCatList[i];else qa.method=QA_METHODS[i];renderQuickAdd()}
function renderQuickAdd(){
  document.querySelectorAll('#quickAdd [data-qtype]').forEach(b=>b.classList.toggle('on',b.dataset.qtype===qa.type));
  qaCatList=qaCats(qa.type);if(!qa.cat||!qaCatList.includes(qa.cat))qa.cat=qaCatList[0]||'';
  $('qaCats').innerHTML=qaCatList.map((c,i)=>`<button type="button" class="chip-btn ${c===qa.cat?'on':''}" onclick="qaPick('cat',${i})">${esc(c)}</button>`).join('');
  let isExp=qa.type==='expense';
  $('qaMethods').innerHTML=isExp?QA_METHODS.map((m,i)=>`<button type="button" class="chip-btn ${m===qa.method?'on':''}" onclick="qaPick('method',${i})">${m}</button>`).join(''):'';
  $('qaMethods').classList.toggle('hidden',!isExp);
  let showCard=isExp&&qa.method==='Card',showAcc=meta.accounts.length&&!showCard;
  $('qaCard').classList.toggle('hidden',!showCard);
  let accSel=$('qaAccount');
  fillSelect(accSel,meta.accounts.map(a=>({value:a.id,label:a.name})),'— No account —');
  accSel.classList.toggle('hidden',!showAcc);
  accSel.parentElement.classList.toggle('hidden',!showCard&&!showAcc)
}
async function saveQuickAdd(){
  let amount=parseAmount(val('qaAmount'));if(!amount){$('qaAmount').focus();return}
  let type=qa.type,date=val('qaDate')||today(),note=val('qaNote').trim(),account=val('qaAccount'),obj;
  if(type==='expense'){
    let method=qa.method,cardId=method==='Card'?(+val('qaCard')||null):null;
    if(method==='Card'&&state.creditcards.length&&!cardId){$('qaCard').focus();return alert('Pick which card you paid with.')}
    obj={date,amount,cat:qa.cat,method,note,account:method==='Card'?'':(meta.accounts.length?account:''),cardId};
    localStorage.setItem('qaMethod',method);if(cardId)localStorage.setItem('qaCard',String(cardId))
  }else obj={date,amount,cat:qa.cat,note,account:meta.accounts.length?account:''};
  if(obj.account!==undefined)localStorage.setItem('qaAccount-'+type,obj.account||'');
  let id=await save(type,obj);
  $('quickAdd').close();
  await refreshAndSync();
  let undo=()=>deleteWithTombstone(type,id).then(refreshAndSync);
  let msg=`${money(amount)} · ${obj.cat} saved`;
  if(type==='expense')checkBudget(obj.cat,date,()=>toast(msg,{undo}));else toast(msg,{undo})
}

// ---------- Bank / UPI SMS reader ----------
// Reads the common Indian bank, card and UPI (GPay/PhonePe/Paytm/BHIM) message formats.
const SMS_MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
const SMS_BANKS=['hdfc','sbi','icici','axis','kotak','canara','indian bank','iob','indian overseas','pnb','punjab national','bob','baroda','union bank','idfc','yes bank','federal','au bank','au small','indusind','paytm','airtel','jupiter','onecard','amex','american express','citi','rbl','equitas','karur','kvb','tmb','tamilnad mercantile','city union','cub','dbs','hsbc','standard chartered','bandhan','central bank','uco','ujjivan'];
function smsYear(y){y=+y;return y<100?2000+y:y}
function smsValidDate(y,m,d){if(!(m>=0&&m<12&&d>=1&&d<=31))return null;let dt=new Date(y,m,d);return dt.getFullYear()===y&&dt.getMonth()===m&&dt.getDate()===d?dt:null}
function parseSmsDate(t){
  let m,c=[],now=new Date(),thisYear=now.getFullYear();
  if((m=t.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/)))c.push(smsValidDate(+m[1],+m[2]-1,+m[3]));
  if((m=t.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})\b/)))c.push(smsValidDate(smsYear(m[3]),+m[2]-1,+m[1]));
  if((m=t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-\/]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,\-\/]*('?\d{4}|'?\d{2})?(?!\d)/i)))
    c.push(smsValidDate(m[3]?smsYear(m[3].replace("'","")):thisYear,SMS_MONTHS[m[2].toLowerCase()],+m[1]));
  if((m=t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\b/i)))
    c.push(smsValidDate(m[3]?+m[3]:thisYear,SMS_MONTHS[m[1].toLowerCase()],+m[2]));
  for(let d of c){if(d&&d-now<=86400000&&now-d<=400*86400000)return ymd(d)} // ignore impossible / far-off dates
  return null
}
function parseSmsAmount(t){
  let re=/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,m;
  while((m=re.exec(t))){
    let before=t.slice(Math.max(0,m.index-25),m.index).toLowerCase();
    if(/(bal|balance|limit|lmt|avl|avail|available)[^a-z0-9]*(is|of)?[^a-z0-9]*$/.test(before))continue; // skip "Avl Bal Rs 1,234"
    let v=parseFloat(m[1].replace(/,/g,''));if(v>0)return Math.round(v*100)/100
  }
  m=t.match(/\b(?:debited|credited|spent|paid|sent|received|withdrawn|deposited)\s+(?:by|for|of|with|amount)?\s*(?:rs\.?|inr|₹)?\s*([\d,]*\d(?:\.\d{1,2})?)/i);
  if(m){let v=parseFloat(m[1].replace(/,/g,''));if(v>0)return Math.round(v*100)/100}
  return null
}
function cleanSmsMerchant(s){
  s=String(s||'').trim().replace(/^(merchant|vpa|m\/s\.?|mr\.?|mrs\.?|ms\.?|shri|smt\.?)\s+/i,'').replace(/^(neft|imps|rtgs|upi|ach|nach)[\-\/:\s]+/i,'');
  if(!s.includes('@'))s=s.split(/-(?=[A-Za-z])/)[0]; // "ACME TECH-SALARY SEP" -> "ACME TECH"
  s=s.replace(/[\s.,\-:;*\/]+$/,'').trim();
  if(!s||s.length<2)return'';
  if(/^(rs|inr|₹)\b/i.test(s)||/^[\d.,\s]+$/.test(s))return'';
  if(/^(your|you|a\/?c|ac|account|acct|xx+|x+\d+|\*+\d+|beneficiary|the|bank|card|upi|imps|neft|rtgs|mobile|linked|self|ref|date)\b/i.test(s))return'';
  if(s.includes('@')){let u=s.split('@')[0];s=/^\d+$/.test(u)?s:u.replace(/[._\-]+/g,' ').trim()}
  if(s===s.toUpperCase()||s===s.toLowerCase())s=s.toLowerCase().replace(/\b[a-z]/g,c=>c.toUpperCase());
  return s.slice(0,40)
}
function parseSmsMerchant(t,type){
  const END='(?=\\s*(?:\\(|\\bon\\b|\\bvia\\b|\\bref|\\bupi\\b|\\bavl|\\bavail|\\bif\\b|\\bnot\\b|\\bthru\\b|\\busing\\b|\\bfrom\\b|\\bdated\\b|\\.(?:\\s|$)|,|;|-\\s|$))';
  const NAME="([A-Za-z0-9][A-Za-z0-9.\\-_@ &'*]{1,45}?)";
  const pats=type==='income'
    ?[new RegExp('\\bfrom\\s+(?:vpa\\s+)?'+NAME+END,'gi'),new RegExp('\\bby\\s+(?:vpa\\s+)?'+NAME+END,'gi'),new RegExp('\\binfo[:\\s]+'+NAME+END,'gi')]
    :[new RegExp('\\bat\\s+'+NAME+END,'gi'),new RegExp('\\bto\\s+(?:vpa\\s+)?'+NAME+END,'gi'),new RegExp('\\btowards\\s+'+NAME+END,'gi'),
      /[;.]\s*([A-Za-z][A-Za-z0-9 .&'\-]{1,40}?)\s+credited\b/gi,new RegExp('\\binfo[:\\s]+'+NAME+END,'gi')];
  pats.push(/\bvpa\s*:?\s*([\w.\-]+@[\w.\-]+)/gi);
  for(let re of pats)for(let m of t.matchAll(re)){let s=cleanSmsMerchant(m[1]);if(s)return s}
  return''
}
function parseBankSms(text){
  let t=String(text||'').replace(/\s+/g,' ').trim(),low=t.toLowerCase();
  let amount=parseSmsAmount(t);
  let dm=low.search(/\b(debited|debit|spent|paid|sent|withdrawn|purchase|payment of|txn of|transferred|deducted)\b/);
  let cm=low.search(/\b(credited|credit(?!\s*card)|received|deposited|refund(ed)?|cashback|added to)\b/);
  let type=cm>=0&&(dm<0||cm<dm)?'income':'expense';
  let isAtm=/\batm\b/.test(low)&&/withdr/.test(low);
  let method='';
  if(/\b(upi|vpa|gpay|google ?pay|phonepe|paytm|bhim)\b/.test(low))method='UPI';
  else if(isAtm)method='Cash';
  else if(/debit ?card/.test(low))method='Bank';
  else if(/\bcard\b/.test(low))method='Card';
  else if(/\b(neft|imps|rtgs|a\/c|acct|account)\b/.test(low))method='Bank';
  let last4=(t.match(/(?:\bx+|\*+|ending(?:\s*in|\s*with)?\s*|\bno\.?\s*x*)(\d{3,4})\b/i)||[])[1]||'';
  let bank=SMS_BANKS.find(b=>new RegExp('\\b'+b.replace(/ /g,'\\s*')+'\\b','i').test(low))||'';
  let merchant=isAtm?'ATM withdrawal':parseSmsMerchant(t,type);
  return{amount,type,date:parseSmsDate(t),merchant,method,last4,bank,isAtm,raw:t}
}
// Category guess: your own past entries first, then common Indian merchants.
const SMS_CAT_HINTS=[
  ['Tea Shop',/\btea\b|chai|coffee|tea stall|bakery/],
  ['Petrol',/petrol|fuel|hpcl|bpcl|iocl|indian ?oil|bharat ?petroleum|hindustan ?petroleum|\bshell\b|filling|service station|hp pay/],
  ['Grocery',/bigbasket|blinkit|zepto|dmart|d mart|grocer|supermarket|\bmart\b|instamart|jiomart|kirana|provision|reliance fresh|more retail|nilgiris|vegetable|fruits/],
  ['Food',/swiggy|zomato|restaurant|hotel|cafe|domino|kfc|mcdonald|pizza|biryani|eatery|food|kitchen|\bmess\b|dhaba|sweets|bhavan|saravana|a2b|adyar ananda/],
  ['Bills',/electric|tneb|tangedco|eb bill|airtel|\bjio\b|vodafone|\bvi\b|bsnl|recharge|broadband|\bdth\b|tata ?play|sun direct|\bbill|\bgas\b|lpg|indane|bharatgas|water|insurance|\blic\b|act fibernet/],
  ['EMI',/\bemi\b|loan|bajaj fin|home credit/],
  ['Home',/\brent\b|maintenance|furniture|ikea|pepperfry|hardware|electricals/]
];
function guessSmsCategory(type,merchant,text){
  let list=type==='income'?meta.incomeCats:meta.expenseCats;
  const pick=name=>list.find(c=>c.toLowerCase()===String(name).toLowerCase())||'';
  let mlow=String(merchant||'').toLowerCase();
  if(mlow&&mlow!=='atm withdrawal'){
    let prev=state[type].slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).find(x=>(x.note||'').toLowerCase().startsWith(mlow));
    if(prev&&pick(prev.cat||prev.source))return pick(prev.cat||prev.source)
  }
  let low=(mlow+' '+String(text||'')).toLowerCase();
  if(type==='income'){
    if(/salary|\bsal\b|payroll/.test(low))return pick('Salary');
    if(/interest/.test(low))return pick('Interest');
    if(/refund|cashback|reversal/.test(low))return pick('Other');
    return''
  }
  for(let[cat,re]of SMS_CAT_HINTS)if(re.test(mlow)&&pick(cat))return pick(cat);
  for(let[cat,re]of SMS_CAT_HINTS)if(re.test(low)&&pick(cat))return pick(cat);
  return''
}

function qaShowSmsBox(show){$('qaSmsBox').classList.toggle('hidden',!show);if(show)setTimeout(()=>$('qaSmsText').focus(),80)}
async function pasteSms(){
  // read the clipboard directly when the browser allows it; otherwise show a box to paste into
  try{if(navigator.clipboard&&navigator.clipboard.readText){let t=await navigator.clipboard.readText();if(t&&parseSmsAmount(t)){applySms(t);return}}}catch(e){}
  qaShowSmsBox(true)
}
function applySms(text){
  let info=$('qaSmsInfo'),r=parseBankSms(text);
  if(!$('quickAdd').open)return openQuickAdd(r.type,{smsText:text});
  info.classList.remove('hidden');
  if(!r.amount){info.innerHTML='<span class="expense">Couldn\'t find an amount in that message — paste the full bank / UPI SMS.</span>';qaShowSmsBox(true);return}
  qaShowSmsBox(false);$('qaSmsText').value='';
  qa.type=r.type;qa.cat='';
  if(r.type==='expense'&&r.method)qa.method=r.method;
  let guess=guessSmsCategory(r.type,r.merchant,r.raw);if(guess)qa.cat=guess;
  renderQuickAdd();
  $('qaAmount').value=r.amount;$('qaDate').value=r.date||today();$('qaNote').value=r.merchant||'';
  // pick the account / card whose name mentions the bank or the last 4 digits
  let match=name=>(r.last4&&String(name).includes(r.last4))||(r.bank&&String(name).toLowerCase().includes(r.bank));
  let acc=meta.accounts.find(a=>match(a.name));
  $('qaAccount').value=acc?acc.id:(localStorage.getItem('qaAccount-'+qa.type)||'');
  if(qa.method==='Card'){let c=state.creditcards.find(c=>match(c.cardName));if(c)$('qaCard').value=String(c.id)}
  let date=val('qaDate');
  let dup=state[qa.type].find(x=>Math.abs(x.amount-r.amount)<0.01&&x.date===date&&(!r.merchant||(x.note||'').toLowerCase().includes(r.merchant.toLowerCase())));
  info.innerHTML=`✅ Filled from SMS: <b>${money(r.amount)}</b> ${r.type==='income'?'received':'spent'}${r.merchant?' · '+esc(r.merchant):''} · ${formatDueDate(date)}${r.date?'':' (no date in SMS — using today)'}${guess?'':' · <b>pick a category</b>'} — check and tap Save.`
    +(r.isAtm?'<br><span class="muted">ATM cash withdrawal — you may prefer to log what you spend the cash on instead.</span>':'')
    +(dup?`<br><span class="expense">⚠ Looks like this is already added (${money(dup.amount)} on ${formatDueDate(dup.date)}${dup.note?' — '+esc(dup.note):''}).</span>`:'')
}

// ---------- Mobile bottom tab bar ----------
const NAV_MAIN=['dash','expense','dues'];
function updateBottomNav(id){
  document.querySelectorAll('.bottom-nav [data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===id||(b.dataset.nav==='more'&&!NAV_MAIN.includes(id))));
  document.querySelectorAll('#moreSheet [data-more]').forEach(b=>b.classList.toggle('active',b.dataset.more===id))
}
function openMore(){let d=$('moreSheet');if(!d.open&&!isLocked())d.showModal()}
function moreGo(id){$('moreSheet').close();show(id)}
function updateNavBadge(items){
  let n=items.filter(i=>daysFromToday(i.date)<=3).length,b=$('navDuesBadge');
  b.textContent=n>9?'9+':n;b.classList.toggle('hidden',!n)
}

// ---------- Home-screen shortcut / link actions (?quick=expense, ?quick=income, ?search=1, ?tab=dues) ----------
let pendingAction=null;
function handleUrlAction(){
  let p=new URLSearchParams(location.search),fn=null;
  // Android "Share" from the Messages app arrives as ?text=… (manifest share_target)
  if(p.get('text')||p.get('title')){let txt=[p.get('title'),p.get('text'),p.get('url')].filter(Boolean).join(' ');fn=()=>openQuickAdd('expense',{smsText:txt})}
  else if(p.get('quick')==='sms')fn=()=>openQuickAdd('expense',{paste:true});
  else if(p.get('quick'))fn=()=>openQuickAdd(p.get('quick')==='income'?'income':'expense');
  else if(p.has('search'))fn=()=>$('globalSearch').focus();
  else if(p.get('tab')){let t=p.get('tab');if($(t)&&$(t).tagName==='SECTION')fn=()=>show(t)}
  if(!fn)return;
  history.replaceState(null,'',location.pathname);
  if(isLocked())pendingAction=fn;else fn() // wait for the PIN if the app is locked
}

// ---------- Start-up ----------
(async()=>{
  await openDB();
  $('iDate').value=today();$('eDate').value=today();$('month').value=thisYM();$('dueStart').value=thisYM();$('rStart').value=thisYM();
  onRecurTypeChange();
  $('loanStart').value=today();
  await refresh();
  resetIncomeForm();resetExpenseForm();
  handleUrlAction();
  refreshNotifStatus();refreshPinUI();requestPersistence();refreshSyncUI();
  setupServiceWorker();
  if(navigator.onLine)await syncNow(); // pull other devices' changes before logging recurring entries
  await runRecurring()
})();
