const DB='financeDB', VER=4; let db, state={income:[],expense:[],dues:[],creditcards:[],advances:[],notes:[],documents:[]}, deferredPrompt=null;
const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const pad=n=>String(n).padStart(2,'0');
// Local-calendar date strings — never use toISOString() for a "today"/"this
// month" key, since it always converts to UTC and silently shifts the date
// for anyone in a timezone ahead of UTC (e.g. wrong day overnight in India,
// or month-trend charts permanently off by one).
function ymd(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function ymOf(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)}
function openDB(){return new Promise((res,rej)=>{let r=indexedDB.open(DB,VER);r.onupgradeneeded=()=>{let d=r.result;['income','expense','dues','creditcards','advances','notes','documents','tombstones'].forEach(x=>{if(!d.objectStoreNames.contains(x))d.createObjectStore(x,{keyPath:'id',autoIncrement:true})})};r.onsuccess=()=>{db=r.result;res()};r.onerror=()=>rej(r.error)})}
function all(store){return new Promise((res,rej)=>{let r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function putExact(store,obj){return new Promise((res,rej)=>{let tx=db.transaction(store,'readwrite').objectStore(store);let r=obj.id?tx.put(obj):tx.add(obj);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function save(store,obj){obj.updatedAt=Date.now();return putExact(store,obj)}
function deleteRecord(store,id){return new Promise(res=>{let r=db.transaction(store,'readwrite').objectStore(store).delete(id);r.onsuccess=()=>res();r.onerror=()=>res()})}
// Stores that go through Google Sheets sync. Deleting a record here must be
// remembered as a tombstone — otherwise the very next sync sees the item
// still sitting in the Sheet, has no way to know it was deleted on purpose,
// and quietly restores it (the "deleted item comes back" bug).
const SYNCED_STORES=new Set(['income','expense','dues','creditcards','advances','notes']);
function addTombstone(storeName,recordId){
  if(!SYNCED_STORES.has(storeName)||recordId==null)return Promise.resolve();
  let obj={id:storeName+':'+recordId,store:storeName,recordId,deletedAt:Date.now()};
  return new Promise(res=>{let r=db.transaction('tombstones','readwrite').objectStore('tombstones').put(obj);r.onsuccess=()=>res();r.onerror=()=>res()})
}
async function deleteWithTombstone(storeName,id){await addTombstone(storeName,id);await deleteRecord(storeName,id)}
function del(store,id){deleteWithTombstone(store,id).then(refreshAndSync)}
let syncDebounceTimer=null;
function refreshAndSync(){
  return refresh().then(()=>{
    if(!navigator.onLine)return;
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer=setTimeout(()=>syncNow(),1200) // wait for a pause in edits so a burst of changes syncs once, not once-per-edit
  })
}
function today(){return ymd(new Date())}
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
    if(!x.paymentDates){x.paymentDates={};itemChanged=true}
    if(itemChanged){await save('dues',x);anyChanged=true}
  }
  if(anyChanged)state.dues=await all('dues')
}

async function normalizeAdvances(){
  let anyChanged=false;
  for(let x of state.advances){
    if(!Array.isArray(x.payments)){
      // an existing "Settled" advance from before payment tracking is assumed fully repaid
      x.payments=x.status==='settled'?[{date:x.settledDate||today(),amount:x.amount}]:[];
      await save('advances',x);anyChanged=true
    }
  }
  if(anyChanged)state.advances=await all('advances')
}
async function normalizeCards(){
  let anyChanged=false;
  for(let x of state.creditcards){
    if(!Array.isArray(x.payments)){
      // an old card marked "paid" under the previous system is treated as
      // fully paid for the balance it had then; otherwise it starts fresh
      let wasPaid=(x.paidDates||[]).length>0;
      x.payments=wasPaid?[{date:today(),amount:x.balance}]:[];
      if(x.billingDay===undefined)x.billingDay=null;
      await save('creditcards',x);anyChanged=true
    }
  }
  if(anyChanged)state.creditcards=await all('creditcards')
}
async function refresh(){for(let k of Object.keys(state))state[k]=await all(k);await normalizeDues();await normalizeAdvances();await normalizeCards();render();if('Notification'in window&&Notification.permission==='granted')checkDueNotifications()}

// ---------- Income ----------
let editingIncomeId=null;
function resetIncomeForm(){document.getElementById('iAmount').value='';document.getElementById('iCat').value='Salary';document.getElementById('iNote').value='';document.getElementById('iDate').value=today();editingIncomeId=null;document.getElementById('iSaveBtn').textContent='Save Income';document.getElementById('iCancelEdit').classList.add('hidden')}
async function addIncome(){let amount=+val('iAmount');if(!amount)return alert('Enter amount');let obj={date:val('iDate')||today(),amount,cat:val('iCat'),note:val('iNote')};if(editingIncomeId)obj.id=editingIncomeId;await save('income',obj);resetIncomeForm();refreshAndSync()}
function editIncome(id){let x=state.income.find(r=>r.id===id);if(!x)return;editingIncomeId=id;document.getElementById('iDate').value=x.date;document.getElementById('iAmount').value=x.amount;document.getElementById('iCat').value=x.cat||x.source||'Other';document.getElementById('iNote').value=x.note||'';document.getElementById('iSaveBtn').textContent='Update Income';document.getElementById('iCancelEdit').classList.remove('hidden');show('income',document.querySelectorAll('.tabs button')[1]);window.scrollTo(0,0)}
function cancelIncomeEdit(){resetIncomeForm()}
function renderIncomeList(){
  let q=(document.getElementById('iSearch')?.value||'').toLowerCase();
  let rows=state.income.filter(x=>!q||[x.date,x.cat||x.source,x.note].some(v=>String(v||'').toLowerCase().includes(q))).slice().sort((a,b)=>b.date.localeCompare(a.date));
  incomeList.innerHTML=rows.map(x=>`<div class="row"><span>${esc(x.date)}</span><b class="income">${money(x.amount)}</b><span>${esc(x.cat||x.source||'')}</span><span>${esc(x.note)}</span><span class="actions"><button class="btn" onclick="editIncome(${x.id})">Edit</button><button class="btn danger" onclick="del('income',${x.id})">Delete</button></span></div>`).join('')||'<p class="muted">💰 No income records yet — add your first one above.</p>'
}

// ---------- Expense ----------
let editingExpenseId=null;
function resetExpenseForm(){document.getElementById('eAmount').value='';document.getElementById('eCat').value='Food';document.getElementById('eMethod').value='Cash';document.getElementById('eNote').value='';document.getElementById('eDate').value=today();editingExpenseId=null;document.getElementById('eSaveBtn').textContent='Save Expense';document.getElementById('eCancelEdit').classList.add('hidden')}
async function addExpense(){let amount=+val('eAmount');if(!amount)return alert('Enter amount');let obj={date:val('eDate')||today(),amount,cat:val('eCat'),method:val('eMethod'),note:val('eNote')};if(editingExpenseId)obj.id=editingExpenseId;await save('expense',obj);resetExpenseForm();refreshAndSync()}
function editExpense(id){let x=state.expense.find(r=>r.id===id);if(!x)return;editingExpenseId=id;document.getElementById('eDate').value=x.date;document.getElementById('eAmount').value=x.amount;document.getElementById('eCat').value=x.cat||'Others';document.getElementById('eMethod').value=x.method||'Cash';document.getElementById('eNote').value=x.note||'';document.getElementById('eSaveBtn').textContent='Update Expense';document.getElementById('eCancelEdit').classList.remove('hidden');show('expense',document.querySelectorAll('.tabs button')[2]);window.scrollTo(0,0)}
function cancelExpenseEdit(){resetExpenseForm()}
function renderExpenseList(){
  let q=(document.getElementById('eSearch')?.value||'').toLowerCase();
  let rows=state.expense.filter(x=>!q||[x.date,x.cat,x.method,x.note].some(v=>String(v||'').toLowerCase().includes(q))).slice().sort((a,b)=>b.date.localeCompare(a.date));
  expenseList.innerHTML=rows.map(x=>`<div class="row"><span>${esc(x.date)}</span><b class="expense">${money(x.amount)}</b><span>${esc(x.cat)}</span><span>${esc(x.note)} ${x.method?'('+esc(x.method)+')':''}</span><span class="actions"><button class="btn" onclick="editExpense(${x.id})">Edit</button><button class="btn danger" onclick="del('expense',${x.id})">Delete</button></span></div>`).join('')||'<p class="muted">💸 No expense records yet — add your first one above.</p>'
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
  await save('dues',obj);resetDueForm();refreshAndSync()
}
function editDue(id){let x=state.dues.find(r=>r.id===id);if(!x)return;editingDueId=id;document.getElementById('dueName').value=x.name;document.getElementById('dueAmount').value=x.amount;document.getElementById('dueDay').value=(x.days||[]).join(', ');document.getElementById('dueSaveBtn').textContent='Update Due';document.getElementById('dueCancelEdit').classList.remove('hidden');show('dues',document.querySelectorAll('.tabs button')[3]);window.scrollTo(0,0)}
function cancelDueEdit(){resetDueForm()}
async function deleteDue(id){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  if(!confirm('Delete "'+x.name+'"? This also removes any expenses it auto-logged when marked paid.'))return;
  for(let expId of Object.values(x.linkedExpenses||{}))await deleteWithTombstone('expense',expId);
  await deleteWithTombstone('dues',id);refreshAndSync()
}
async function toggleDueDay(id,dateStr){
  let x=state.dues.find(d=>d.id===id);if(!x)return;
  x.paidDates=x.paidDates||[];x.linkedExpenses=x.linkedExpenses||{};x.paymentDates=x.paymentDates||{};
  let i=x.paidDates.indexOf(dateStr);
  if(i>=0){
    // marking pending again — remove the auto-added expense, if any
    x.paidDates.splice(i,1);
    delete x.paymentDates[dateStr];
    let expId=x.linkedExpenses[dateStr];
    if(expId){await deleteWithTombstone('expense',expId);delete x.linkedExpenses[dateStr]}
  }else{
    // marking paid — record today as the actual payment date, and auto-log a matching expense
    x.paidDates.push(dateStr);
    x.paymentDates[dateStr]=today();
    let expId=await save('expense',{date:dateStr,amount:x.amount,cat:'Bills',method:'',note:x.name+' (auto)'});
    x.linkedExpenses[dateStr]=expId
  }
  await save('dues',x);refreshAndSync()
}
function formatDueDate(dateStr){let d=new Date(dateStr+'T00:00:00');return d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
function dueRemainingLabel(day){
  let diff=day-new Date().getDate();
  if(diff>0)return `⏳ Due in ${diff} day${diff===1?'':'s'}`;
  if(diff===0)return'⏰ Due today';
  return `⚠️ Overdue by ${Math.abs(diff)} day${Math.abs(diff)===1?'':'s'}`
}
function remainingLabelFromDays(diff){
  if(diff>0)return `⏳ Due in ${diff} day${diff===1?'':'s'}`;
  if(diff===0)return'⏰ Due today';
  return `⚠️ Overdue by ${Math.abs(diff)} day${Math.abs(diff)===1?'':'s'}`
}
// A card's due date isn't always "this month": if the due day falls earlier
// in the calendar than the billing day (e.g. billed on the 14th, due on the
// 3rd), that due date belongs to the month AFTER billing, not the current
// month. This finds the actual due date for the most recent billing cycle.
function cardDueDate(x){
  let billingDay=x.billingDay||x.dueDay;
  let now=new Date();now.setHours(0,0,0,0);
  let y=now.getFullYear(),m=now.getMonth();
  let mostRecentBilling=now.getDate()>=billingDay?new Date(y,m,billingDay):new Date(y,m-1,billingDay);
  // Prefer an exact "N days after billing" cycle when given — this is how
  // most real card cycles actually work, and avoids you having to manually
  // work out which day-of-month that lands on (e.g. billed the 14th, 20-day
  // cycle → automatically the 4th of next month).
  if(x.cycleDays){
    let d=new Date(mostRecentBilling);d.setDate(d.getDate()+x.cycleDays);return d
  }
  let dueMonthOffset=x.dueDay>=billingDay?0:1;
  return new Date(mostRecentBilling.getFullYear(),mostRecentBilling.getMonth()+dueMonthOffset,x.dueDay)
}
function cardDaysUntilDue(x){
  let due=cardDueDate(x);due.setHours(0,0,0,0);
  let today=new Date();today.setHours(0,0,0,0);
  return Math.round((due-today)/86400000)
}
function cardDueLabel(x){return remainingLabelFromDays(cardDaysUntilDue(x))}
function renderDues(){
  let ym=today().slice(0,7);
  dueList.innerHTML=state.dues.map(x=>{
    let pills=(x.days||[]).map(d=>{let dateStr=ym+'-'+pad(d);let paid=(x.paidDates||[]).includes(dateStr);let paidOn=x.paymentDates&&x.paymentDates[dateStr];return `<span class="pill ${paid?'paid':''}" style="cursor:pointer" onclick="toggleDueDay(${x.id},'${dateStr}')">${formatDueDate(dateStr)}: ${paid?'✓ Paid'+(paidOn?' on '+formatDueDate(paidOn):''):dueRemainingLabel(d)}</span>`}).join(' ');
    return `<div class="due-flex"><b style="min-width:140px">${esc(x.name)}</b><span style="min-width:80px">${money(x.amount)}</span><span class="actions" style="flex:1;flex-wrap:wrap">${pills}</span><span class="actions"><button class="btn" onclick="editDue(${x.id})">Edit</button><button class="btn danger" onclick="deleteDue(${x.id})">Delete</button></span></div>`
  }).join('')||'<p class="muted">📅 No monthly dues yet — add a bill above.</p>';
  let pending=[];
  for(let x of state.dues)for(let d of (x.days||[])){let dateStr=ym+'-'+pad(d);if(!(x.paidDates||[]).includes(dateStr))pending.push({name:x.name,amount:x.amount,day:d,dateStr})}
  pending.sort((a,b)=>a.day-b.day);
  dashDues.innerHTML=pending.map(x=>`<div class="row"><b>${esc(x.name)}</b><span>${money(x.amount)}</span><span>${formatDueDate(x.dateStr)}</span><span class="pill">${dueRemainingLabel(x.day)}</span></div>`).join('')||'<p class="muted">✅ Nothing pending — you\'re all caught up!</p>'
}

// ---------- Credit Cards (balance + due date + payment tracking) ----------
let editingCardId=null;
function resetCardForm(){document.getElementById('cardName').value='';document.getElementById('cardBalance').value='';document.getElementById('cardLimit').value='';document.getElementById('cardBillingDay').value='';document.getElementById('cardCycleDays').value='';document.getElementById('cardDueDay').value='';editingCardId=null;document.getElementById('cardSaveBtn').textContent='Save Card';document.getElementById('cardCancelEdit').classList.add('hidden')}
function cardRemaining(x){return x.balance-(x.payments||[]).reduce((a,p)=>a+p.amount,0)}
async function addCard(){
  let cardName=val('cardName'),balance=+val('cardBalance'),limit=val('cardLimit')?+val('cardLimit'):null,billingDay=val('cardBillingDay')?parseInt(val('cardBillingDay'),10):null,cycleDays=val('cardCycleDays')?parseInt(val('cardCycleDays'),10):null,dueDayRaw=val('cardDueDay'),dueDay=dueDayRaw?parseInt(dueDayRaw,10):null;
  if(!cardName||!balance)return alert('Enter card name and current outstanding');
  if(!cycleDays&&!dueDay)return alert('Enter either a Due day, or a billing-cycle length in days');
  if(dueDay!=null&&(dueDay<1||dueDay>31))return alert('Due day must be between 1 and 31');
  if(billingDay!=null&&(billingDay<1||billingDay>31))return alert('Billing day must be between 1 and 31');
  if(cycleDays&&!billingDay)return alert('A billing-cycle length needs a Billing day to count from');
  let existing=editingCardId?state.creditcards.find(c=>c.id===editingCardId):null;
  let obj={cardName,balance,limit,billingDay,cycleDays,dueDay:dueDay||billingDay,payments:existing?existing.payments||[]:[]};
  if(editingCardId)obj.id=editingCardId;
  await save('creditcards',obj);resetCardForm();refreshAndSync()
}
function editCard(id){let x=state.creditcards.find(r=>r.id===id);if(!x)return;editingCardId=id;document.getElementById('cardName').value=x.cardName;document.getElementById('cardBalance').value=x.balance;document.getElementById('cardLimit').value=x.limit||'';document.getElementById('cardBillingDay').value=x.billingDay||'';document.getElementById('cardCycleDays').value=x.cycleDays||'';document.getElementById('cardDueDay').value=x.cycleDays?'':x.dueDay;document.getElementById('cardSaveBtn').textContent='Update Card';document.getElementById('cardCancelEdit').classList.remove('hidden');show('cards',document.querySelectorAll('.tabs button')[4]);window.scrollTo(0,0)}
function cancelCardEdit(){resetCardForm()}
async function deleteCard(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  if(!confirm('Delete "'+x.cardName+'"?'))return;
  // clean up any expenses an OLDER version of this feature may have auto-logged
  for(let expId of Object.values(x.linkedExpenses||{}))await deleteWithTombstone('expense',expId);
  await deleteWithTombstone('creditcards',id);refreshAndSync()
}
async function addCardPayment(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  let remaining=cardRemaining(x);
  let amtStr=prompt('How much did you just pay towards '+x.cardName+'? (remaining: '+money(remaining)+')');
  if(amtStr===null)return;
  let amt=+amtStr;
  if(!amt||amt<=0)return alert('Enter a valid positive amount.');
  x.payments=x.payments||[];
  x.payments.push({date:today(),amount:amt});
  await save('creditcards',x);refreshAndSync()
}
async function newStatement(id){
  let x=state.creditcards.find(c=>c.id===id);if(!x)return;
  let newBalStr=prompt('New statement for '+x.cardName+' — enter the new outstanding balance:',x.balance);
  if(newBalStr===null)return;
  let newBal=+newBalStr;
  if(newBal<0||isNaN(newBal))return alert('Enter a valid amount (0 or more).');
  x.balance=newBal;x.payments=[];
  await save('creditcards',x);refreshAndSync()
}
function renderCards(){
  cardList.innerHTML=state.creditcards.map(x=>{
    let remaining=cardRemaining(x);
    let paidSoFar=(x.payments||[]).reduce((a,p)=>a+p.amount,0);
    let util=x.limit?Math.round(x.balance/x.limit*100):null;
    let outstandingLine=paidSoFar>0&&remaining>0
      ?`Outstanding: ${money(remaining)} <span class="muted" style="font-weight:400">(${money(paidSoFar)} of ${money(x.balance)} paid)</span>`
      :remaining<=0&&x.balance>0
      ?`<span class="income">✓ Fully paid this cycle</span>`
      :`Outstanding: ${money(x.balance)}`;
    let billingInfo=x.billingDay?`<span class="muted" style="min-width:120px">Billing day ${x.billingDay}${x.cycleDays?' + '+x.cycleDays+'d cycle':''}</span>`:'';
    return `<div class="due-flex"><b style="min-width:140px">${esc(x.cardName)}</b><span style="min-width:160px">${outstandingLine}</span>${x.limit?`<span class="muted" style="min-width:150px">Limit: ${money(x.limit)} (${util}% used)</span>`:''}${billingInfo}<span class="pill">${formatDueDate(ymd(cardDueDate(x)))}: ${cardDueLabel(x)}</span><span class="actions">${remaining>0?`<button class="btn" onclick="addCardPayment(${x.id})">+ Payment</button>`:''}<button class="btn" onclick="newStatement(${x.id})">New Statement</button><button class="btn" onclick="editCard(${x.id})">Edit</button><button class="btn danger" onclick="deleteCard(${x.id})">Delete</button></span></div>`
  }).join('')||'<p class="muted">💳 No credit cards added yet.</p>';
  let totalBalance=state.creditcards.reduce((a,x)=>a+cardRemaining(x),0);
  let totalLimit=state.creditcards.reduce((a,x)=>a+(x.limit||0),0);
  let cardSummaryEl=document.getElementById('cardSummary');
  if(cardSummaryEl)cardSummaryEl.innerHTML=`<div class="card"><small>Total Outstanding</small><div class="amount expense">${money(totalBalance)}</div></div>${totalLimit?`<div class="card"><small>Total Credit Limit</small><div class="amount">${money(totalLimit)}</div></div>`:''}`
}

// ---------- Advances (money lent/borrowed) ----------
let editingAdvanceId=null;
function resetAdvanceForm(){document.getElementById('advPerson').value='';document.getElementById('advAmount').value='';document.getElementById('advDueDate').value='';document.getElementById('advNote').value='';document.getElementById('advDirection').value='given';editingAdvanceId=null;document.getElementById('advSaveBtn').textContent='Save Advance';document.getElementById('advCancelEdit').classList.add('hidden')}
function advanceRemaining(x){return x.amount-(x.payments||[]).reduce((a,p)=>a+p.amount,0)}
async function addAdvance(){
  let person=val('advPerson'),amount=+val('advAmount'),direction=val('advDirection');
  if(!person||!amount)return alert('Enter person and amount');
  let existing=editingAdvanceId?state.advances.find(a=>a.id===editingAdvanceId):null;
  let obj={person,amount,direction,status:existing?existing.status:'pending',dueDate:val('advDueDate'),note:val('advNote'),payments:existing?existing.payments||[]:[]};
  if(existing&&existing.settledDate)obj.settledDate=existing.settledDate;
  if(editingAdvanceId)obj.id=editingAdvanceId;
  await save('advances',obj);resetAdvanceForm();refreshAndSync()
}
function editAdvance(id){let x=state.advances.find(r=>r.id===id);if(!x)return;editingAdvanceId=id;document.getElementById('advPerson').value=x.person;document.getElementById('advAmount').value=x.amount;document.getElementById('advDirection').value=x.direction;document.getElementById('advDueDate').value=x.dueDate||'';document.getElementById('advNote').value=x.note||'';document.getElementById('advSaveBtn').textContent='Update Advance';document.getElementById('advCancelEdit').classList.remove('hidden');show('advances',document.querySelectorAll('.tabs button')[5]);window.scrollTo(0,0)}
function cancelAdvanceEdit(){resetAdvanceForm()}
async function toggleAdvanceStatus(id){
  let x=state.advances.find(a=>a.id===id);if(!x)return;
  if(x.status==='pending'){
    // marking fully settled by hand — log one payment covering whatever's left, so the math still adds up
    let remaining=advanceRemaining(x);
    if(remaining>0){x.payments=x.payments||[];x.payments.push({date:today(),amount:remaining})}
    x.status='settled';x.settledDate=today()
  }else{
    x.status='pending';delete x.settledDate
  }
  await save('advances',x);refreshAndSync()
}
async function addAdvancePayment(id){
  let x=state.advances.find(a=>a.id===id);if(!x)return;
  let remaining=advanceRemaining(x);
  let verb=x.direction==='given'?'they paid you back':'you paid back';
  let amtStr=prompt('How much '+verb+' just now? (remaining: '+money(remaining)+')');
  if(amtStr===null)return;
  let amt=+amtStr;
  if(!amt||amt<=0)return alert('Enter a valid positive amount.');
  x.payments=x.payments||[];
  x.payments.push({date:today(),amount:amt});
  if(advanceRemaining(x)<=0){x.status='settled';x.settledDate=today()}
  await save('advances',x);refreshAndSync()
}
function safeDisplayDate(v){
  if(!v)return'';
  let d10=String(v).slice(0,10); // tolerate any leftover full-timestamp value from before the sync fix
  return /^\d{4}-\d{2}-\d{2}$/.test(d10)?formatDueDate(d10):esc(String(v))
}
function renderAdvances(){
  let net={};
  for(let a of state.advances){if(a.status!=='pending')continue;let rem=advanceRemaining(a);net[a.person]=(net[a.person]||0)+(a.direction==='given'?rem:-rem)}
  let owedToYou=Object.values(net).filter(v=>v>0).reduce((a,b)=>a+b,0);
  let youOwe=Object.values(net).filter(v=>v<0).reduce((a,b)=>a+Math.abs(b),0);
  let summaryEl=document.getElementById('advanceSummary');
  if(summaryEl)summaryEl.innerHTML=`<div class="card"><small>Owed to you</small><div class="amount income">${money(owedToYou)}</div></div><div class="card"><small>You owe</small><div class="amount expense">${money(youOwe)}</div></div>`;
  let rows=state.advances.slice().sort((a,b)=>(a.status==='settled'?1:0)-(b.status==='settled'?1:0)||b.id-a.id);
  advanceList.innerHTML=rows.map(x=>{
    let paidSoFar=(x.payments||[]).reduce((a,p)=>a+p.amount,0);
    let remaining=advanceRemaining(x);
    let amountLine=paidSoFar>0&&x.status==='pending'
      ?`${x.direction==='given'?'They owe':'You owe'} ${money(remaining)} <span class="muted" style="font-weight:400">(${money(paidSoFar)} of ${money(x.amount)} repaid)</span>`
      :`${x.direction==='given'?'They owe':'You owe'} ${money(x.amount)}`;
    return `<div class="row"><span>${esc(x.person)}</span><b class="${x.direction==='given'?'income':'expense'}">${amountLine}</b><span>${safeDisplayDate(x.dueDate)} ${x.note?esc(x.note):''}</span><span class="pill ${x.status==='settled'?'paid':''}" style="cursor:pointer" onclick="toggleAdvanceStatus(${x.id})">${x.status==='settled'?'✓ Settled'+(x.settledDate?' on '+safeDisplayDate(x.settledDate):''):'⏳ Pending'}</span><span class="actions">${x.status==='pending'?`<button class="btn" onclick="addAdvancePayment(${x.id})">+ Payment</button>`:''}<button class="btn" onclick="editAdvance(${x.id})">Edit</button><button class="btn danger" onclick="del('advances',${x.id})">Delete</button></span></div>`
  }).join('')||'<p class="muted">🤝 No advances yet — track money lent or borrowed here.</p>'
}

// ---------- Notes ----------
let editingNoteId=null;
function resetNoteForm(){document.getElementById('noteTitle').value='';document.getElementById('noteContent').value='';editingNoteId=null;document.getElementById('noteSaveBtn').textContent='Save Note';document.getElementById('noteCancelEdit').classList.add('hidden')}
async function addNote(){
  let title=val('noteTitle');if(!title)return alert('Enter a title');
  let obj={title,content:val('noteContent'),date:today()};
  if(editingNoteId)obj.id=editingNoteId;
  await save('notes',obj);resetNoteForm();refreshAndSync()
}
function editNote(id){let x=state.notes.find(r=>r.id===id);if(!x)return;editingNoteId=id;document.getElementById('noteTitle').value=x.title;document.getElementById('noteContent').value=x.content||'';document.getElementById('noteSaveBtn').textContent='Update Note';document.getElementById('noteCancelEdit').classList.remove('hidden');show('notes',document.querySelectorAll('.tabs button')[7]);window.scrollTo(0,0)}
function cancelNoteEdit(){resetNoteForm()}
function renderNotes(){
  let rows=state.notes.slice().sort((a,b)=>b.id-a.id);
  noteList.innerHTML=rows.map(x=>`<div class="row" style="grid-template-columns:1fr auto"><span><b>${esc(x.title)}</b><br><span class="muted">${esc((x.content||'').slice(0,120))}</span></span><span class="actions"><button class="btn" onclick="editNote(${x.id})">Edit</button><button class="btn danger" onclick="del('notes',${x.id})">Delete</button></span></div>`).join('')||'<p class="muted">📝 No notes yet.</p>'
}

// ---------- Documents ----------
let documentUrlCache=new Map(); // doc.id -> object URL, created once and reused (avoids leaking a new blob URL on every render)
function getDocumentUrl(doc){
  if(!doc.blob)return'';
  if(!documentUrlCache.has(doc.id))documentUrlCache.set(doc.id,URL.createObjectURL(doc.blob));
  return documentUrlCache.get(doc.id)
}
function revokeDocumentUrl(id){if(documentUrlCache.has(id)){URL.revokeObjectURL(documentUrlCache.get(id));documentUrlCache.delete(id)}}
function revokeAllDocumentUrls(){for(let url of documentUrlCache.values())URL.revokeObjectURL(url);documentUrlCache.clear()}
async function deleteDocument(id){revokeDocumentUrl(id);await deleteRecord('documents',id);refreshAndSync()}
async function addDocument(){
  let fileInput=document.getElementById('docFile');
  let file=fileInput.files[0];
  let title=val('docTitle')||( file?file.name:'');
  if(!file)return alert('Choose a file first');
  if(file.size>20*1024*1024)return alert('File too large for on-device storage (20MB limit).');
  let obj={title,tags:val('docTags'),fileName:file.name,fileType:file.type,blob:file,dateAdded:today()};
  await save('documents',obj);
  fileInput.value='';document.getElementById('docTitle').value='';document.getElementById('docTags').value='';
  refreshAndSync() // Documents themselves don't sync (binary), but this keeps other tabs in sync too
}
function renderDocuments(){
  let rows=state.documents.slice().sort((a,b)=>b.id-a.id);
  documentList.innerHTML=rows.map(x=>{let url=getDocumentUrl(x);return `<div class="row" style="grid-template-columns:1fr auto"><span><b>${esc(x.title)}</b><br><span class="muted">${esc(x.tags||'')} · ${esc(x.dateAdded)}</span></span><span class="actions">${url?`<a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>`:''}<button class="btn danger" onclick="deleteDocument(${x.id})">Delete</button></span></div>`}).join('')||'<p class="muted">📄 No documents yet.</p>'
}


function render(){
  let inc=state.income.reduce((a,x)=>a+x.amount,0),exp=state.expense.reduce((a,x)=>a+x.amount,0);
  dIncome.textContent=money(inc);dExpense.textContent=money(exp);dBalance.textContent=money(inc-exp);
  renderIncomeList();renderExpenseList();renderDues();renderCards();renderAdvances();renderNotes();renderDocuments();renderDashInsights();report()
}
function daysInMonth(ym){let[y,m]=ym.split('-').map(Number);return new Date(y,m,0).getDate()}
function daysElapsedInMonth(ym){let now=new Date();let curYM=ymOf(now);if(ym===curYM)return now.getDate();if(ym<curYM)return daysInMonth(ym);return 0}
function renderDashInsights(){
  let el=document.getElementById('dashInsights');if(!el)return;
  let now=new Date();let thisYM=ymOf(now);
  let lastYM=ymOf(new Date(now.getFullYear(),now.getMonth()-1,1));
  let thisInc=state.income.filter(x=>x.date.startsWith(thisYM)).reduce((a,x)=>a+x.amount,0);
  let thisExp=state.expense.filter(x=>x.date.startsWith(thisYM)).reduce((a,x)=>a+x.amount,0);
  let lastExp=state.expense.filter(x=>x.date.startsWith(lastYM)).reduce((a,x)=>a+x.amount,0);
  let savingsRate=thisInc>0?((thisInc-thisExp)/thisInc*100):0;
  let spendChange=lastExp>0?((thisExp-lastExp)/lastExp*100):(thisExp>0?100:0);
  let dEl=now.getDate();
  let dailyAvg=dEl>0?thisExp/dEl:0;
  let netAdv=0;for(let a of state.advances)if(a.status==='pending')netAdv+=(a.direction==='given'?a.amount:-a.amount);
  let totalBalance=state.income.reduce((a,x)=>a+x.amount,0)-state.expense.reduce((a,x)=>a+x.amount,0);
  el.innerHTML=`
    <div class="insight"><small>Savings rate (this month)</small><b class="${savingsRate>=0?'income':'expense'}">${savingsRate.toFixed(0)}%</b></div>
    <div class="insight"><small>Spend vs last month</small><b>${money(thisExp)}</b><span class="delta ${spendChange<=0?'up':'down'}">${spendChange>=0?'▲':'▼'} ${Math.abs(spendChange).toFixed(0)}%</span></div>
    <div class="insight"><small>Daily avg spend</small><b>${money(dailyAvg)}</b></div>
    <div class="insight"><small>Net worth (incl. advances)</small><b class="${totalBalance+netAdv>=0?'income':'expense'}">${money(totalBalance+netAdv)}</b></div>
  `
}
function show(id,btn){document.querySelectorAll('main>section').forEach(x=>x.classList.add('hidden'));document.getElementById(id).classList.remove('hidden');document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');if(id==='reports')report()}

// ---------- Reports + charts ----------
function lastNMonths(n){let out=[];let now=new Date();for(let i=n-1;i>=0;i--){let dt=new Date(now.getFullYear(),now.getMonth()-i,1);out.push(ymOf(dt))}return out}
function report(){
  let m=val('month')||today().slice(0,7);
  let inc=state.income.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
  let exp=state.expense.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
  reportBox.innerHTML=`<div><small>Income</small><br><b class="income">${money(inc)}</b></div><div><small>Expense</small><br><b class="expense">${money(exp)}</b></div><div><small>Balance</small><br><b class="balance">${money(inc-exp)}</b></div>`;
  let cats={};state.expense.filter(x=>x.date.startsWith(m)).forEach(x=>cats[x.cat]=(cats[x.cat]||0)+x.amount);
  catBox.innerHTML='<h3>Expense by Category</h3>'+(Object.entries(cats).map(([k,v])=>`<div class="row"><b>${esc(k)}</b><span>${money(v)}</span></div>`).join('')||'<p class="muted">No expenses for this month.</p>');
  renderReportInsights(m,inc,exp,cats);
  drawCategoryChart(cats);
  drawTrendChart();
  drawSavingsChart()
}
function csvEscape(v){let s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function exportReportCSV(){
  let m=val('month')||today().slice(0,7);
  let rows=[];
  state.income.filter(x=>x.date.startsWith(m)).forEach(x=>rows.push({date:x.date,type:'Income',cat:x.cat||x.source||'',amount:x.amount,detail:x.note||''}));
  state.expense.filter(x=>x.date.startsWith(m)).forEach(x=>rows.push({date:x.date,type:'Expense',cat:x.cat||'',amount:x.amount,detail:[x.method,x.note].filter(Boolean).join(' - ')}));
  rows.sort((a,b)=>a.date.localeCompare(b.date));
  let header=['Date','Type','Category','Amount','Details'];
  let lines=[header,...rows.map(r=>[r.date,r.type,r.cat,r.amount,r.detail])].map(r=>r.map(csvEscape).join(',')).join('\r\n');
  let blob=new Blob([lines],{type:'text/csv;charset=utf-8'});
  let a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='daily-tracker-report-'+m+'.csv';a.click()
}
function exportReportPDF(){window.print()} // print CSS shows only the Reports section — use the browser's own "Save as PDF"
function renderReportInsights(m,inc,exp,cats){
  let el=document.getElementById('reportInsights');if(!el)return;
  let savingsRate=inc>0?((inc-exp)/inc*100):0;
  let entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  let top=entries[0];
  let elapsed=daysElapsedInMonth(m);
  let dailyAvg=elapsed>0?exp/elapsed:0;
  let isCurrentMonth=m===today().slice(0,7);
  let projected=isCurrentMonth?dailyAvg*daysInMonth(m):exp;
  el.innerHTML=`
    <div class="insight"><small>Savings rate</small><b class="${savingsRate>=0?'income':'expense'}">${savingsRate.toFixed(0)}%</b></div>
    <div class="insight"><small>Top category</small><b>${top?esc(top[0]):'—'}</b>${top?`<span class="delta muted">${money(top[1])}</span>`:''}</div>
    <div class="insight"><small>Daily avg spend</small><b>${money(dailyAvg)}</b></div>
    <div class="insight"><small>${isCurrentMonth?'Projected month-end spend':'Total spend'}</small><b>${money(projected)}</b></div>
  `
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
function drawSavingsChart(){
  let canvas=document.getElementById('savingsChart');if(!canvas)return;
  let months=lastNMonths(6);
  let rates=months.map(m=>{
    let inc=state.income.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
    let exp=state.expense.filter(x=>x.date.startsWith(m)).reduce((a,x)=>a+x.amount,0);
    return inc>0?((inc-exp)/inc*100):0
  });
  let {ctx,w,h}=setupCanvas(canvas);ctx.clearRect(0,0,w,h);
  let maxV=Math.max(...rates,0)*1.15||10;
  let minV=Math.min(...rates,0)*1.15;
  let padL=45,padB=30,padT=15,padR=14;let chartW=w-padL-padR,chartH=h-padT-padB;
  let range=(maxV-minV)||1;
  let n=months.length,gap=chartW/Math.max(n-1,1);
  let yFor=v=>padT+chartH-((v-minV)/range)*chartH;
  let zeroY=yFor(0);
  ctx.strokeStyle='#d5dbea';ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL,padT+chartH);ctx.lineTo(padL+chartW,padT+chartH);ctx.stroke();
  if(minV<0){ctx.strokeStyle='#e2e8f0';ctx.beginPath();ctx.moveTo(padL,zeroY);ctx.lineTo(padL+chartW,zeroY);ctx.stroke()}
  ctx.strokeStyle='#2563eb';ctx.lineWidth=2;ctx.beginPath();
  months.forEach((mo,i)=>{let x=padL+i*gap,y=yFor(rates[i]);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});
  ctx.stroke();ctx.lineWidth=1;
  months.forEach((mo,i)=>{
    let x=padL+i*gap,y=yFor(rates[i]);
    ctx.fillStyle=rates[i]>=0?'#15803d':'#dc2626';ctx.beginPath();ctx.arc(x,y,3.5,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#172033';ctx.textAlign='center';ctx.font='11px Arial';ctx.fillText(mo.slice(5)+'/'+mo.slice(2,4),x,padT+chartH+14)
  });
  ctx.fillStyle='#667085';ctx.textAlign='right';ctx.fillText(Math.round(maxV)+'%',padL-6,padT+10);ctx.fillText(Math.round(minV)+'%',padL-6,padT+chartH)
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
const REMINDER_LEAD_DAYS=10; // start nudging this many days before something's due, not just on the day
async function checkDueNotifications(){
  if(!('Notification'in window)||Notification.permission!=='granted'||!('serviceWorker'in navigator))return;
  let reg=await navigator.serviceWorker.ready;let ym=today().slice(0,7);let todayDay=new Date().getDate();let todayStr=today();
  let notified=JSON.parse(localStorage.getItem('notifiedDues')||'{}');
  for(let x of state.dues){
    for(let d of (x.days||[])){
      let dateStr=ym+'-'+pad(d);let key='due-'+x.id+'-'+dateStr;
      if((d-todayDay)<=REMINDER_LEAD_DAYS&&!(x.paidDates||[]).includes(dateStr)&&notified[key]!==todayStr){
        reg.showNotification('Due reminder: '+x.name,{body:money(x.amount)+' — due on day '+d+' this month.',tag:key,icon:'icon-192.png',badge:'icon-192.png'});
        notified[key]=todayStr
      }
    }
  }
  for(let x of state.creditcards){
    let remaining=cardRemaining(x);
    if(remaining<=0)continue;
    let daysUntil=cardDaysUntilDue(x);
    let dueDateStr=ymd(cardDueDate(x));
    let key='card-'+x.id+'-'+dueDateStr;
    if(daysUntil<=REMINDER_LEAD_DAYS&&notified[key]!==todayStr){
      reg.showNotification('Card payment due: '+x.cardName,{body:money(remaining)+' — due '+formatDueDate(dueDateStr)+'.',tag:key,icon:'icon-192.png',badge:'icon-192.png'});
      notified[key]=todayStr
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
function backupIsOverdue(){
  let last=localStorage.getItem('lastBackup');
  if(!last)return true;
  let days=Math.floor((Date.now()-new Date(last).getTime())/86400000);
  return days>=7
}
async function autoBackupIfDue(){
  if(!backupIsOverdue())return;
  try{await exportData()}catch(e){} // browser may block a download with no user click yet — banner still shows as a fallback
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
function blobToBase64(blob){return new Promise((res,rej)=>{if(!(blob instanceof Blob))return res(null);let r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)})}
function base64ToBlob(dataUrl){return fetch(dataUrl).then(r=>r.blob())}
async function exportData(){
  let exportState={...state};
  exportState.documents=await Promise.all(state.documents.map(async d=>{
    try{return {...d,blob:d.blob?await blobToBase64(d.blob):null}}
    catch(e){return {...d,blob:null}} // skip a corrupt/unreadable file rather than failing the whole backup
  }));
  let out=JSON.stringify(exportState,null,2),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'application/json'}));a.download='daily-tracker-backup-'+today()+'.json';a.click();localStorage.setItem('lastBackup',new Date().toISOString());refreshBackupBanner()
}
async function importData(e){
  let f=e.target.files[0];if(!f)return;let data=JSON.parse(await f.text());if(!data.income||!data.expense||!data.dues)return alert('Invalid backup');
  revokeAllDocumentUrls();
  await clearStores();
  for(let k of Object.keys(state)){
    for(let x of (data[k]||[])){
      let y={...x};delete y.id;
      if(k==='documents'&&y.blob)y.blob=await base64ToBlob(y.blob);
      await put_raw(k,y)
    }
  }
  refresh();alert('Backup restored')
}
function put_raw(store,obj){return new Promise((res,rej)=>{let r=db.transaction(store,'readwrite').objectStore(store).add(obj);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function clearStores(){return Promise.all(Object.keys(state).map(k=>new Promise(r=>{let q=db.transaction(k,'readwrite').objectStore(k).clear();q.onsuccess=()=>r()})))}
async function clearAll(){if(confirm('Delete all finance data from this device?')){revokeAllDocumentUrls();await clearStores();refresh()}}

// ---------- App Lock (PIN, hashed — never stored or synced in plain text) ----------
async function sha256Hex(text){
  let buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')
}
function getLockHash(){return localStorage.getItem('appLockHash')||''}
function setLockHash(h){localStorage.setItem('appLockHash',h)}
function clearLockHash(){localStorage.removeItem('appLockHash')}
async function tryUnlock(){
  let pin=document.getElementById('lockPinInput').value;
  let hash=await sha256Hex(pin);
  if(hash&&hash===getLockHash()){
    document.documentElement.classList.remove('app-locked');
    document.getElementById('lockScreen').classList.add('hidden');
    document.getElementById('lockPinInput').value='';
    document.getElementById('lockError').textContent=''
  }else{
    document.getElementById('lockError').textContent='Incorrect PIN — try again.';
    document.getElementById('lockPinInput').value='';
    document.getElementById('lockPinInput').focus()
  }
}
async function setAppLock(){
  let pin=val('newPinInput'),confirmPin=val('confirmPinInput');
  if(!pin||pin.length<4)return alert('PIN must be at least 4 characters.');
  if(pin!==confirmPin)return alert('PINs do not match.');
  if(!confirm('Lock this app with this PIN? You will need to enter it every time you open the app on this device.'))return;
  setLockHash(await sha256Hex(pin));
  document.getElementById('newPinInput').value='';document.getElementById('confirmPinInput').value='';
  refreshLockStatus();
  alert('App lock set. This device will ask for this PIN next time you open the app.')
}
function removeAppLock(){
  if(!confirm('Remove the app lock? Anyone opening this app on this device will see your data without a PIN.'))return;
  clearLockHash();refreshLockStatus()
}
function refreshLockStatus(){
  let has=!!getLockHash();
  let el=document.getElementById('lockStatusText');if(el)el.textContent=has?'🔒 PIN is set on this device':'Not set';
  let btn=document.getElementById('removeLockBtn');if(btn)btn.classList.toggle('hidden',!has)
}

let installEvent; window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e});async function installApp(){if(installEvent){installEvent.prompt();installEvent=null}else alert('On Chrome Android, use the browser menu → Add to Home screen.')}

(async()=>{
  await openDB();
  document.getElementById('iDate').value=today();document.getElementById('eDate').value=today();document.getElementById('month').value=today().slice(0,7);
  await refresh();refreshNotifStatus();requestPersistence();refreshBackupBanner();refreshSyncUI();refreshLockStatus();autoBackupIfDue();
  if('serviceWorker'in navigator){await navigator.serviceWorker.register('sw.js');if('Notification'in window&&Notification.permission==='granted'){checkDueNotifications();tryPeriodicSync()}}
  if(navigator.onLine)syncNow(); // auto-sync in the background on load; safe to skip silently if offline
})()


// ========== Google Sheets two-way sync (via Apps Script Web App) ==========
// No OAuth, no sign-in, no consent screen — just a URL + a shared secret you set yourself.
// Built-in defaults — set once, syncs immediately on every device without
// needing to paste anything in Settings. Anyone who views this public
// repo's source can see these, so treat this URL+token as a shared password
// for this Google Sheet, not a private secret.
const DEFAULT_SCRIPT_URL='https://script.google.com/macros/s/AKfycbyZwnxmg4AYQpC8Hu9Ln1mO_x_0JFus4CARV9Pn5u9OLcjeKBhM00grHAp_1Qd8FeEC5A/exec';
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
  Dues:['id','name','amount','days','paidDates','linkedExpenses','updatedAt','paymentDates'],
  CreditCards:['id','cardName','balance','limit','dueDay','paidDates','linkedExpenses','paymentDates','updatedAt','billingDay','payments','cycleDays'],
  Advances:['id','person','amount','direction','status','dueDate','note','updatedAt','settledDate','payments'],
  Notes:['id','title','content','date','updatedAt'],
  Tombstones:['id','store','recordId','deletedAt']
};

function rowsToObjects(tab,rows){
  return (rows||[]).map(r=>{
    if(tab==='Income')return{id:r[0]?+r[0]:undefined,date:r[1]||today(),amount:+r[2]||0,cat:r[3]||'Other',note:r[4]||'',updatedAt:r[5]?+r[5]:Date.now()};
    if(tab==='Expense')return{id:r[0]?+r[0]:undefined,date:r[1]||today(),amount:+r[2]||0,cat:r[3]||'Others',method:r[4]||'',note:r[5]||'',updatedAt:r[6]?+r[6]:Date.now()};
    if(tab==='Dues')return{id:r[0]?+r[0]:undefined,name:r[1]||'Untitled',amount:+r[2]||0,days:parseDays(r[3]||''),paidDates:String(r[4]||'').split(',').map(s=>s.trim()).filter(Boolean),linkedExpenses:(()=>{try{return JSON.parse(r[5]||'{}')}catch(e){return{}}})(),updatedAt:r[6]?+r[6]:Date.now(),paymentDates:(()=>{try{return JSON.parse(r[7]||'{}')}catch(e){return{}}})()};
    if(tab==='CreditCards')return{id:r[0]?+r[0]:undefined,cardName:r[1]||'Untitled',balance:+r[2]||0,limit:r[3]?+r[3]:null,dueDay:+r[4]||1,paidDates:String(r[5]||'').split(',').map(s=>s.trim()).filter(Boolean),linkedExpenses:(()=>{try{return JSON.parse(r[6]||'{}')}catch(e){return{}}})(),paymentDates:(()=>{try{return JSON.parse(r[7]||'{}')}catch(e){return{}}})(),updatedAt:r[8]?+r[8]:Date.now(),billingDay:r[9]?+r[9]:null,payments:(()=>{try{return JSON.parse(r[10]||'[]')}catch(e){return[]}})(),cycleDays:r[11]?+r[11]:null};
    if(tab==='Advances')return{id:r[0]?+r[0]:undefined,person:r[1]||'',amount:+r[2]||0,direction:r[3]==='taken'?'taken':'given',status:r[4]==='settled'?'settled':'pending',dueDate:r[5]||'',note:r[6]||'',updatedAt:r[7]?+r[7]:Date.now(),settledDate:r[8]||undefined,payments:(()=>{try{return JSON.parse(r[9]||'[]')}catch(e){return[]}})()};
    if(tab==='Tombstones')return{id:r[0]||'',store:r[1]||'',recordId:r[2]?+r[2]:undefined,deletedAt:r[3]?+r[3]:0};
    return{id:r[0]?+r[0]:undefined,title:r[1]||'Untitled',content:r[2]||'',date:r[3]||today(),updatedAt:r[4]?+r[4]:Date.now()}
  })
}
function objectToRow(tab,x){
  if(tab==='Income')return[x.id,x.date,x.amount,x.cat||x.source||'',x.note||'',x.updatedAt||Date.now()];
  if(tab==='Expense')return[x.id,x.date,x.amount,x.cat||'',x.method||'',x.note||'',x.updatedAt||Date.now()];
  if(tab==='Dues')return[x.id,x.name,x.amount,(x.days||[]).join(','),(x.paidDates||[]).join(','),JSON.stringify(x.linkedExpenses||{}),x.updatedAt||Date.now(),JSON.stringify(x.paymentDates||{})];
  if(tab==='CreditCards')return[x.id,x.cardName,x.balance,x.limit||'',x.dueDay,(x.paidDates||[]).join(','),JSON.stringify(x.linkedExpenses||{}),JSON.stringify(x.paymentDates||{}),x.updatedAt||Date.now(),x.billingDay||'',JSON.stringify(x.payments||[]),x.cycleDays||''];
  if(tab==='Advances')return[x.id,x.person,x.amount,x.direction,x.status,x.dueDate||'',x.note||'',x.updatedAt||Date.now(),x.settledDate||'',JSON.stringify(x.payments||[])];
  if(tab==='Tombstones')return[x.id,x.store,x.recordId,x.deletedAt];
  return[x.id,x.title,x.content||'',x.date,x.updatedAt||Date.now()]
}

// Safe two-way merge: newer updatedAt wins on shared ids; records only on one
// side are added to the other. This alone never deletes anything — that's
// handled separately via tombstones (see syncNow), since a record missing
// from one side is ambiguous: it might mean "deleted there" or just "that
// device hasn't synced it in yet".
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

async function scriptGetAll(){
  let url=getScriptUrl(),token=getSyncToken();
  let res=await fetch(url+'?all=1&token='+encodeURIComponent(token));
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();
  if(data.error)throw new Error('Script error: '+data.error);
  return data.tabs||{}
}
async function scriptPostAll(tabsData){
  let url=getScriptUrl(),token=getSyncToken();
  let res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({token,all:true,tabs:tabsData})});
  if(!res.ok)throw new Error('Script request failed: HTTP '+res.status);
  let data=await res.json();
  if(data.error)throw new Error('Script error: '+data.error)
}
// One retry on transient network hiccups (mobile drops, brief Apps Script cold-start blips)
async function withRetry(fn,label){
  try{return await fn()}
  catch(e){
    updateSyncStatus(label+' failed once, retrying…');
    await new Promise(r=>setTimeout(r,800));
    return await fn()
  }
}
const TAB_STORE_MAP={Income:'income',Expense:'expense',Dues:'dues',CreditCards:'creditcards',Advances:'advances',Notes:'notes'};
let isSyncing=false,syncQueued=false;
async function syncNow(){
  if(isSyncing){syncQueued=true;return} // avoid two overlapping syncs racing on the same rows — queue instead
  isSyncing=true;
  let btn=document.getElementById('syncNowBtn');if(btn)btn.disabled=true;
  try{
    if(!getScriptUrl()||!getSyncToken())throw new Error('Paste your Apps Script URL and token above first, then Save.');
    updateSyncStatus('Syncing…');
    // Single round-trip down: every tab's rows in one response.
    let remoteTabs=await withRetry(()=>scriptGetAll(),'Fetching');

    // Merge this device's delete history with whatever other devices have
    // recorded, so a deletion made anywhere eventually applies everywhere.
    let remoteTombstones=rowsToObjects('Tombstones',remoteTabs.Tombstones);
    let localTombstones=await all('tombstones');
    let tombMap=new Map();
    for(let t of[...localTombstones,...remoteTombstones]){
      let existing=tombMap.get(t.id);
      if(!existing||t.deletedAt>existing.deletedAt)tombMap.set(t.id,t)
    }
    for(let t of tombMap.values())await putExact('tombstones',t);

    for(let tab of Object.keys(TAB_STORE_MAP)){
      let storeName=TAB_STORE_MAP[tab];
      let remote=rowsToObjects(tab,remoteTabs[tab]);
      let merged=mergeRecords(state[storeName],remote);
      // A tombstoned record is dropped unless it was genuinely edited again
      // after the deletion (updatedAt newer than deletedAt) — that counts as
      // an intentional recreation, not a stale record coming back to life.
      merged=merged.filter(obj=>{
        let tomb=obj.id!=null?tombMap.get(storeName+':'+obj.id):null;
        return!tomb||(obj.updatedAt||0)>tomb.deletedAt
      });
      let keepIds=new Set(merged.filter(o=>o.id!=null).map(o=>o.id));
      for(let existing of state[storeName])if(existing.id!=null&&!keepIds.has(existing.id))await deleteRecord(storeName,existing.id);
      for(let obj of merged){let newId=await putExact(storeName,obj);if(!obj.id)obj.id=newId}
      state[storeName]=await all(storeName)
    }

    // Single round-trip up: every tab's rows in one request, tombstones included.
    let outgoing={};
    for(let tab of Object.keys(TAB_STORE_MAP))outgoing[tab]=state[TAB_STORE_MAP[tab]].map(x=>objectToRow(tab,x));
    outgoing.Tombstones=[...tombMap.values()].map(x=>objectToRow('Tombstones',x));
    await withRetry(()=>scriptPostAll(outgoing),'Saving');
    localStorage.setItem('lastSync',new Date().toISOString());
    refresh();
    updateSyncStatus('Synced ✓ — just now')
  }catch(e){updateSyncStatus('Sync failed: '+e.message)}
  finally{
    isSyncing=false;if(btn)btn.disabled=false;
    if(syncQueued){syncQueued=false;syncNow()}
  }
}
function refreshSyncUI(){
  let urlEl=document.getElementById('gsScriptUrlInput');if(urlEl&&!urlEl.value)urlEl.value=getScriptUrl();
  let tokenEl=document.getElementById('gsSyncTokenInput');if(tokenEl&&!tokenEl.value)tokenEl.value=getSyncToken();
  let last=localStorage.getItem('lastSync');
  updateSyncStatus(last?('Last synced: '+new Date(last).toLocaleString()):'Not synced yet')
}
