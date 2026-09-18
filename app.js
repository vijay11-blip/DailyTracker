const DB='financeDB', VER=1; let db, state={income:[],expense:[],dues:[]}, deferredPrompt=null;
const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const pad=n=>String(n).padStart(2,'0');
function openDB(){return new Promise((res,rej)=>{let r=indexedDB.open(DB,VER);r.onupgradeneeded=()=>{let d=r.result;['income','expense','dues'].forEach(x=>{if(!d.objectStoreNames.contains(x))d.createObjectStore(x,{keyPath:'id',autoIncrement:true})})};r.onsuccess=()=>{db=r.result;res()};r.onerror=()=>rej(r.error)})}
function all(store){return new Promise((res,rej)=>{let r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function putExact(store,obj){return new Promise((res,rej)=>{let tx=db.transaction(store,'readwrite').objectStore(store);let r=obj.id?tx.put(obj):tx.add(obj);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function save(store,obj){obj.updatedAt=Date.now();return putExact(store,obj)}
function deleteRecord(store,id){return new Promise(res=>{let r=db.transaction(store,'readwrite').objectStore(store).delete(id);r.onsuccess=()=>res();r.onerror=()=>res()})}
function del(store,id){deleteRecord(store,id).then(refresh)}
function today(){return new Date().toISOString().slice(0,10)}
function val(id){return document.getElementById(id).value}

async function normalizeDues(){
  let anyChanged=false;
  for(let x of state.dues){
    let itemChanged=false;
    if(!Array.isArray(x.days)){
      x.days=x.day?[x.day]:[];
      x.paidDates=x.paidDates||(x.paid&&x.day?[today().slice(0,7)+'-'+pad(x.day)]:[]);
      delete x.day;delete x.paid;
      itemChanged=true
    }
    if(!x.linkedExpenses){x.linkedExpenses={};itemChanged=true}
    if(itemChanged){await save('dues',x);anyChanged=true}
  }
  if(anyChanged)state.dues=await all('dues')
}

async function refresh(){for(let k of Object.keys(state))state[k]=await all(k);await normalizeDues();render();if('Notification'in window&&Notification.permission==='granted')checkDueNotifications()}

// ---------- Income ----------
let editingIncomeId=null;
function resetIncomeForm(){document.getElementById('iAmount').value='';document.getElementById('iCat').value='Salary';document.getElementById('iNote').value='';document.getElementById('iDate').value=today();editingIncomeId=null;document.getElementById('iSaveBtn').textContent='Save Income';document.getElementById('iCancelEdit').classList.add('hidden')}
async function addIncome(){let amount=+val('iAmount');if(!amount)return alert('Enter amount');let obj={date:val('iDate')||today(),amount,cat:val('iCat'),note:val('iNote')};if(editingIncomeId)obj.id=editingIncomeId;await save('income',obj);resetIncomeForm();refresh()}
function editIncome(id){let x=state.income.find(r=>r.id===id);if(!x)return;editingIncomeId=id;document.getElementById('iDate').value=x.date;document.getElementById('iAmount').value=x.amount;document.getElementById('iCat').value=x.cat||x.source||'Other';document.getElementById('iNote').value=x.note||'';document.getElementById('iSaveBtn').textContent='Update Income';document.getElementById('iCancelEdit').classList.remove('hidden');show('income',document.querySelectorAll('.tabs button')[1]);window.scrollTo(0,0)}
function cancelIncomeEdit(){resetIncomeForm()}
function renderIncomeList(){
  let q=(document.getElementById('iSearch')?.value||'').toLowerCase();
  let rows=state.income.filter(x=>!q||[x.date,x.cat||x.source,x.note].some(v=>String(v||'').toLowerCase().includes(q))).slice().sort((a,b)=>b.date.localeCompare(a.date));
  incomeList.innerHTML=rows.map(x=>`<div class="row"><span>${esc(x.date)}</span><b class="income">${money(x.amount)}</b><span>${esc(x.cat||x.source||'')}</span><span>${esc(x.note)}</span><span class="actions"><button class="btn" onclick="editIncome(${x.id})">Edit</button><button class="btn danger" onclick="del('income',${x.id})">Delete</button></span></div>`).join('')||'<p class="muted">No income records.</p>'
}

// ---------- Expense ----------
let editingExpenseId=null;
function resetExpenseForm(){document.getElementById('eAmount').value='';document.getElementById('eCat').value='Food';document.getElementById('eMethod').value='';document.getElementById('eNote').value='';document.getElementById('eDate').value=today();editingExpenseId=null;document.getElementById('eSaveBtn').textContent='Save Expense';document.getElementById('eCancelEdit').classList.add('hidden')}
async function addExpense(){let amount=+val('eAmount');if(!amount)return alert('Enter amount');let obj={date:val('eDate')||today(),amount,cat:val('eCat'),method:val('eMethod'),note:val('eNote')};if(editingExpenseId)obj.id=editingExpenseId;await save('expense',obj);resetExpenseForm();refresh()}
function editExpense(id){let x=state.expense.find(r=>r.id===id);if(!x)return;editingExpenseId=id;document.getElementById('eDate').value=x.date;document.getElementById('eAmount').value=x.amount;document.getElementById('eCat').value=x.cat||'Other';document.getElementById('eMethod').value=x.method||'';document.getElementById('eNote').value=x.note||'';document.getElementById('eSaveBtn').textContent='Update Expense';document.getElementById('eCancelEdit').classList.remove('hidden');show('expense',document.querySelectorAll('.tabs button')[2]);window.scrollTo(0,0)}
function cancelExpenseEdit(){resetExpenseForm()}
function renderExpenseList(){
  let q=(document.getElementById('eSearch')?.value||'').toLowerCase();
  let rows=state.expense.filter(x=>!q||[x.date,x.cat,x.method,x.note].some(v=>String(v||'').toLowerCase().includes(q))).slice().sort((a,b)=>b.date.localeCompare(a.date));
  expenseList.innerHTML=rows.map(x=>`<div class="row"><span>${esc(x.date)}</span><b class="expense">${money(x.amount)}</b><span>${esc(x.cat)}</span><span>${esc(x.note)} ${x.method?'('+esc(x.method)+')':''}</span><span class="actions"><button class="btn" onclick="editExpense(${x.id})">Edit</button><button class="btn danger" onclick="del('expense',${x.id})">Delete</button></span></div>`).join('')||'<p class="muted">No expense records.</p>'
}

// ---------- Dues (multiple due days per bill) ----------
let editingDueId=null;
function parseDays(str){return [...new Set(String(str).split(',').map(s=>parseInt(s.trim(),10)).filter(n=>n>=1&&n<=31))].sort((a,b)=>a-b)}
function resetDueForm(){document.getElementById('dueName').value='';document.getElementById('dueAmount').value='';document.getElementById('dueDay').value='';editingDueId=null;document.getElementById('dueSaveBtn').textContent='Save Due';document.getElementById('dueCancelEdit').classList.add('hidden')}
async function addDue(){
  let name=val('dueName'),amount=+val('dueAmount'),days=parseDays(val('dueDay'));
  if(!name||!amount||!days.length)return alert('Enter due name, amount and at least one valid due day (1-31, comma-separated for more than one)');
  let existing=editingDueId?state.dues.find(d=>d.id===editingDueId):null;
  let obj={name,amount,days,paidDates:existing?existing.paidDates||[]:[]};
  if(editingDueId)obj.id=editingDueId;
  await save('dues',obj);resetDueForm();refresh()
}
function editDue(id){let x=state.dues.find(r=>r.id===id);if(!x)return;editingDueId=id;document.getElementById('dueName').value=x.name;document.getElementById('dueAmount').value=x.amount;document.getElementById('dueDay').value=(x.days||[]).join(', ');document.getElementById('dueSaveBtn').textContent='Update Due';document.getElementById('dueCancelEdit').classList.remove('hidden');show('dues',document.querySelectorAll('.tabs button')[3]);window.scrollTo(0,0)}
function cancelDueEdit(){resetDueForm()}
async function deleteDue(id){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  if(!confirm('Delete "'+x.name+'"? This also removes any expenses it auto-logged when marked paid.'))return;
  for(let expId of Object.values(x.linkedExpenses||{}))await deleteRecord('expense',expId);
  await deleteRecord('dues',id);refresh()
}
async function toggleDueDay(id,dateStr){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  x.paidDates=x.paidDates||[];x.linkedExpenses=x.linkedExpenses||{};
  let i=x.paidDates.indexOf(dateStr);
  if(i>=0){
    // marking pending again — remove the auto-added expense, if any
    x.paidDates.splice(i,1);
    let expId=x.linkedExpenses[dateStr];
    if(expId){await deleteRecord('expense',expId);delete x.linkedExpenses[dateStr]}
  }else{
    // marking paid — auto-log a matching expense
    x.paidDates.push(dateStr);
    let expId=await save('expense',{date:dateStr,amount:x.amount,cat:'Bills',method:'',note:x.name+' (auto)'});
    x.linkedExpenses[dateStr]=expId
  }
  await save('dues',x);refresh()
}
function renderDues(){
  let ym=today().slice(0,7);
  dueList.innerHTML=state.dues.map(x=>{
    let pills=(x.days||[]).map(d=>{let dateStr=ym+'-'+pad(d);let paid=(x.paidDates||[]).includes(dateStr);return `<span class="pill ${paid?'paid':''}" style="cursor:pointer" onclick="toggleDueDay(${x.id},'${dateStr}')">Day ${d}: ${paid?'Paid':'Pending'}</span>`}).join(' ');
    return `<div class="due-flex"><b style="min-width:140px">${esc(x.name)}</b><span style="min-width:80px">${money(x.amount)}</span><span class="actions" style="flex:1;flex-wrap:wrap">${pills}</span><span class="actions"><button class="btn" onclick="editDue(${x.id})">Edit</button><button class="btn danger" onclick="deleteDue(${x.id})">Delete</button></span></div>`
  }).join('')||'<p class="muted">No monthly dues.</p>';
  let pending=[];
  for(let x of state.dues)for(let d of (x.days||[])){let dateStr=ym+'-'+pad(d);if(!(x.paidDates||[]).includes(dateStr))pending.push({name:x.name,amount:x.amount,day:d})}
  pending.sort((a,b)=>a.day-b.day);
  dashDues.innerHTML=pending.map(x=>`<div class="row"><b>${esc(x.name)}</b><span>${money(x.amount)}</span><span>Due day ${x.day}</span><span class="pill">Pending</span></div>`).join('')||'<p class="muted">No pending dues.</p>'
}

// ---------- Render / navigation ----------
function render(){
  let inc=state.income.reduce((a,x)=>a+x.amount,0),exp=state.expense.reduce((a,x)=>a+x.amount,0);
  dIncome.textContent=money(inc);dExpense.textContent=money(exp);dBalance.textContent=money(inc-exp);
  renderIncomeList();renderExpenseList();renderDues();report()
}
function show(id,btn){document.querySelectorAll('main>section').forEach(x=>x.classList.add('hidden'));document.getElementById(id).classList.remove('hidden');document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');if(id==='reports')report()}

// ---------- Reports + charts ----------
function lastNMonths(n){let out=[];let now=new Date();for(let i=n-1;i>=0;i--){let dt=new Date(now.getFullYear(),now.getMonth()-i,1);out.push(dt.toISOString().slice(0,7))}return out}
function report(){
  let m=val('month')||today().slice(0,7);
  let inc=state.income.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
  let exp=state.expense.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
  reportBox.innerHTML=`<div><small>Income</small><br><b class="income">${money(inc)}</b></div><div><small>Expense</small><br><b class="expense">${money(exp)}</b></div><div><small>Balance</small><br><b class="balance">${money(inc-exp)}</b></div>`;
  let cats={};state.expense.filter(x=>x.date.startsWith(m)).forEach(x=>cats[x.cat]=(cats[x.cat]||0)+x.amount);
  catBox.innerHTML='<h3>Expense by Category</h3>'+(Object.entries(cats).map(([k,v])=>`<div class="row"><b>${esc(k)}</b><span>${money(v)}</span></div>`).join('')||'<p class="muted">No expenses for this month.</p>');
  drawCategoryChart(cats);
  drawTrendChart()
}
function setupCanvas(canvas){let ratio=window.devicePixelRatio||1;let w=canvas.clientWidth||600,h=canvas.clientHeight||220;canvas.width=w*ratio;canvas.height=h*ratio;let ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);return{ctx,w,h}}
function drawCategoryChart(cats){
  let canvas=document.getElementById('catChart');if(!canvas)return;
  let entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  let {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  if(!entries.length){ctx.fillStyle='#667085';ctx.font='13px Arial';ctx.fillText('No expenses this month',10,h/2);return}
  let max=Math.max(...entries.map(e=>e[1]))*1.15;
  let padL=40,padB=34,padT=10,padR=10;let chartW=w-padL-padR,chartH=h-padT-padB;
  let gap=chartW/entries.length,barW=gap*0.6;
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  entries.forEach(([label,v],i)=>{
    let x=padL+i*gap+(gap-barW)/2,barH=chartH*(v/max);
    ctx.fillStyle='#dc2626';ctx.fillRect(x,padT+chartH-barH,barW,barH);
    ctx.fillStyle='#172033';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(String(label).slice(0,10),x+barW/2,padT+chartH+14)
  });
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(max),padL-6,padT+10);ctx.fillText('0',padL-6,padT+chartH)
}
function drawTrendChart(){
  let canvas=document.getElementById('trendChart');if(!canvas)return;
  let months=lastNMonths(6);
  let incVals=months.map(m=>state.income.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0));
  let expVals=months.map(m=>state.expense.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0));
  let {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  let max=Math.max(...incVals,...expVals,1)*1.15;
  let padL=45,padB=30,padT=18,padR=10;let chartW=w-padL-padR,chartH=h-padT-padB;
  let n=months.length,gap=chartW/n,barW=gap*0.32;
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  months.forEach((mo,i)=>{
    let xBase=padL+i*gap+gap*0.18;
    let hA=chartH*(incVals[i]/max),hB=chartH*(expVals[i]/max);
    ctx.fillStyle='#15803d';ctx.fillRect(xBase,padT+chartH-hA,barW,hA);
    ctx.fillStyle='#dc2626';ctx.fillRect(xBase+barW+4,padT+chartH-hB,barW,hB);
    ctx.fillStyle='#172033';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(mo.slice(5)+'/'+mo.slice(2,4),xBase+barW+2,padT+chartH+14)
  });
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(max),padL-6,padT+10);ctx.fillText('0',padL-6,padT+chartH);
  ctx.textAlign='left';ctx.fillStyle='#15803d';ctx.fillRect(padL,0,10,10);ctx.fillStyle='#172033';ctx.font='11px Arial';ctx.fillText('Income',padL+14,9);
  ctx.fillStyle='#dc2626';ctx.fillRect(padL+80,0,10,10);ctx.fillStyle='#172033';ctx.fillText('Expense',padL+94,9)
}

// ---------- Notifications ----------
function notifStatusText(){if(!('Notification'in window))return'Not supported in this browser';return{granted:'Enabled',denied:'Blocked — allow notifications for this app in your browser/OS settings',default:'Not enabled yet'}[Notification.permission]}
function refreshNotifStatus(){let el=document.getElementById('notifStatus');if(el)el.textContent='Status: '+notifStatusText()}
async function enableNotifications(){
  if(!('Notification'in window))return alert('Notifications are not supported in this browser.');
  let perm=await Notification.requestPermission();refreshNotifStatus();
  if(perm==='granted'){checkDueNotifications();tryPeriodicSync()}
  else if(perm==='denied')alert('Notifications are blocked. Enable them from your browser or system app settings to get due reminders.')
}
async function checkDueNotifications(){
  if(!('Notification'in window)||Notification.permission!=='granted'||!('serviceWorker'in navigator))return;
  let reg=await navigator.serviceWorker.ready;let ym=today().slice(0,7);let todayDay=new Date().getDate();let todayStr=today();
  let notified=JSON.parse(localStorage.getItem('notifiedDues')||'{}');
  for(let x of state.dues){
    for(let d of (x.days||[])){
      let dateStr=ym+'-'+pad(d);let key=x.id+'-'+dateStr;
      if(d<=todayDay&&!(x.paidDates||[]).includes(dateStr)&&notified[key]!==todayStr){
        reg.showNotification('Due reminder: '+x.name,{body:money(x.amount)+' was due on day '+d+' this month.',tag:'due-'+key,icon:'icon-192.png',badge:'icon-192.png'});
        notified[key]=todayStr
      }
    }
  }
  localStorage.setItem('notifiedDues',JSON.stringify(notified))
}
async function requestPersistence(){
  if(!(navigator.storage&&navigator.storage.persist))return;
  let already=await navigator.storage.persisted();
  if(!already)await navigator.storage.persist();
  refreshPersistStatus()
}
async function refreshPersistStatus(){
  let el=document.getElementById('persistStatus');if(!el)return;
  if(!(navigator.storage&&navigator.storage.persisted)){el.textContent='Storage protection: not supported in this browser';return}
  let persisted=await navigator.storage.persisted();
  el.textContent='Storage protection: '+(persisted?'On — the browser won\'t auto-clear this data under storage pressure':'Off — ask the browser to protect this data')
}
function refreshBackupBanner(){
  let last=localStorage.getItem('lastBackup');
  let days=last?Math.floor((Date.now()-new Date(last).getTime())/86400000):null;
  let banner=document.getElementById('backupBanner');if(!banner)return;
  let lastText=document.getElementById('lastBackupText');
  if(lastText)lastText.textContent=last?('Last backup: '+days+(days===1?' day':' days')+' ago'):'You have never exported a backup';
  banner.classList.toggle('hidden',!(last===null||days>=7))
}
async function tryPeriodicSync(){
  try{
    let reg=await navigator.serviceWorker.ready;
    if('periodicSync'in reg){
      let status=await navigator.permissions.query({name:'periodic-background-sync'});
      if(status.state==='granted')await reg.periodicSync.register('check-dues',{minInterval:12*60*60*1000})
    }
  }catch(e){}
}

// ---------- Backup ----------
async function exportData(){let out=JSON.stringify(state,null,2),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'application/json'}));a.download='daily-tracker-backup-'+today()+'.json';a.click();localStorage.setItem('lastBackup',new Date().toISOString());refreshBackupBanner()}
async function importData(e){let f=e.target.files[0];if(!f)return;let data=JSON.parse(await f.text());if(!data.income||!data.expense||!data.dues)return alert('Invalid backup');await clearStores();for(let k of Object.keys(state))for(let x of data[k]){let y={...x};delete y.id;await put_raw(k,y)}refresh();alert('Backup restored')}
function put_raw(store,obj){return new Promise((res,rej)=>{let r=db.transaction(store,'readwrite').objectStore(store).add(obj);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function clearStores(){return Promise.all(Object.keys(state).map(k=>new Promise(r=>{let q=db.transaction(k,'readwrite').objectStore(k).clear();q.onsuccess=()=>r()})))}
async function clearAll(){if(confirm('Delete all finance data from this device?')){await clearStores();refresh()}}

let installEvent; window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e});async function installApp(){if(installEvent){installEvent.prompt();installEvent=null}else alert('On Chrome Android, use the browser menu → Add to Home screen.')}

(async()=>{
  await openDB();
  document.getElementById('iDate').value=today();document.getElementById('eDate').value=today();document.getElementById('month').value=today().slice(0,7);
  await refresh();refreshNotifStatus();requestPersistence();refreshBackupBanner();refreshSyncUI();
  if('serviceWorker'in navigator){await navigator.serviceWorker.register('sw.js');if('Notification'in window&&Notification.permission==='granted'){checkDueNotifications();tryPeriodicSync()}}
  if(navigator.onLine)syncNow(); // auto-sync in the background on load; safe to skip silently if offline
})()


// ========== Google Sheets two-way sync (via Apps Script Web App) ==========
// No OAuth, no sign-in, no consent screen — just a URL + a shared secret you set yourself.
// Built-in defaults — set once, syncs immediately on every device without
// needing to paste anything in Settings. Anyone who views this public
// repo's source can see these, so treat this URL+token as a shared password
// for this Google Sheet, not a private secret.
const DEFAULT_SCRIPT_URL='https://script.google.com/macros/s/AKfycbxq9dCuuI9lOuzim_NxeWF1MJ5L_s0T6LFSoTCuXUz7O_bmgJ778nXAKBiTkkw65G6ffw/exec';
const DEFAULT_SYNC_TOKEN='dt-b574d5d72a89ae2b';
function getScriptUrl(){return localStorage.getItem('gsScriptUrl')||DEFAULT_SCRIPT_URL}
function setScriptUrl(v){localStorage.setItem('gsScriptUrl',v)}
function getSyncToken(){return localStorage.getItem('gsSyncToken')||DEFAULT_SYNC_TOKEN}
function setSyncToken(v){localStorage.setItem('gsSyncToken',v)}
function updateSyncStatus(msg){let el=document.getElementById('syncStatus');if(el)el.textContent=msg}

function saveScriptConfig(){
  let url=val('gsScriptUrlInput').trim();
  let token=val('gsSyncTokenInput').trim();
  if(!url)return alert('Paste your Apps Script Web App URL first.');
  if(!token)return alert('Set a secret token (any word/phrase — must match what you put in the script).');
  setScriptUrl(url);setSyncToken(token);
  updateSyncStatus('Saved. Tap "Sync Now" whenever you want to sync.')
}

const SHEET_TABS={
  Income:['id','date','amount','cat','note','updatedAt'],
  Expense:['id','date','amount','cat','method','note','updatedAt'],
  Dues:['id','name','amount','days','paidDates','linkedExpenses','updatedAt']
};

function rowsToObjects(tab,rows){
  return (rows||[]).map(r=>{
    if(tab==='Income')return{id:r[0]?+r[0]:undefined,date:r[1]||today(),amount:+r[2]||0,cat:r[3]||'Other',note:r[4]||'',updatedAt:r[5]?+r[5]:Date.now()};
    if(tab==='Expense')return{id:r[0]?+r[0]:undefined,date:r[1]||today(),amount:+r[2]||0,cat:r[3]||'Other',method:r[4]||'',note:r[5]||'',updatedAt:r[6]?+r[6]:Date.now()};
    return{id:r[0]?+r[0]:undefined,name:r[1]||'Untitled',amount:+r[2]||0,days:parseDays(r[3]||''),paidDates:String(r[4]||'').split(',').map(s=>s.trim()).filter(Boolean),linkedExpenses:(()=>{try{return JSON.parse(r[5]||'{}')}catch(e){return{}}})(),updatedAt:r[6]?+r[6]:Date.now()}
  })
}
function objectToRow(tab,x){
  if(tab==='Income')return[x.id,x.date,x.amount,x.cat||x.source||'',x.note||'',x.updatedAt||Date.now()];
  if(tab==='Expense')return[x.id,x.date,x.amount,x.cat||'',x.method||'',x.note||'',x.updatedAt||Date.now()];
  return[x.id,x.name,x.amount,(x.days||[]).join(','),(x.paidDates||[]).join(','),JSON.stringify(x.linkedExpenses||{}),x.updatedAt||Date.now()]
}

// Safe two-way merge: newer updatedAt wins on shared ids; records only on one
// side are added to the other. Never auto-deletes — deleting stays a manual,
// explicit action on whichever side you deleted it.
function mergeRecords(localArr,remoteArr){
  let result=localArr.map(r=>Object.assign({},r));
  let byId=new Map(result.filter(r=>r.id!=null).map(r=>[r.id,r]));
  for(let r of remoteArr){
    if(r.id!=null&&byId.has(r.id)){
      let existing=byId.get(r.id);
      if((r.updatedAt||0)>(existing.updatedAt||0))Object.assign(existing,r,{id:existing.id})
    }else if(r.id!=null){
      let obj=Object.assign({},r);result.push(obj);byId.set(obj.id,obj)
    }else{
      let obj=Object.assign({},r);delete obj.id;result.push(obj)
    }
  }
  return result
}

async function scriptGet(tab){
  let url=getScriptUrl(),token=getSyncToken();
  let res=await fetch(url+'?tab='+encodeURIComponent(tab)+'&token='+encodeURIComponent(token));
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();
  if(data.error)throw new Error('Script error: '+data.error);
  return data.rows||[]
}
async function scriptPost(tab,rows){
  let url=getScriptUrl(),token=getSyncToken();
  // text/plain avoids a CORS preflight that Apps Script web apps don't handle
  let res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({token,tab,rows})});
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();
  if(data.error)throw new Error('Script error: '+data.error)
}

async function syncStore(tab,storeName){
  let remoteRows=await scriptGet(tab);
  let remote=rowsToObjects(tab,remoteRows);
  let merged=mergeRecords(state[storeName],remote);
  for(let obj of merged){let newId=await putExact(storeName,obj);if(!obj.id)obj.id=newId}
  state[storeName]=await all(storeName);
  await scriptPost(tab,state[storeName].map(x=>objectToRow(tab,x)))
}
async function syncNow(){
  let btn=document.getElementById('syncNowBtn');if(btn)btn.disabled=true;
  try{
    if(!getScriptUrl()||!getSyncToken())throw new Error('Paste your Apps Script URL and token above first, then Save.');
    updateSyncStatus('Syncing…');
    await syncStore('Income','income');
    await syncStore('Expense','expense');
    await syncStore('Dues','dues');
    localStorage.setItem('lastSync',new Date().toISOString());
    refresh();
    updateSyncStatus('Synced ✓ — just now')
  }catch(e){updateSyncStatus('Sync failed: '+e.message)}
  finally{if(btn)btn.disabled=false}
}
function refreshSyncUI(){
  let urlEl=document.getElementById('gsScriptUrlInput');if(urlEl&&!urlEl.value)urlEl.value=getScriptUrl();
  let tokenEl=document.getElementById('gsSyncTokenInput');if(tokenEl&&!tokenEl.value)tokenEl.value=getSyncToken();
  let last=localStorage.getItem('lastSync');
  updateSyncStatus(last?('Last synced: '+new Date(last).toLocaleString()):'Not synced yet')
}
