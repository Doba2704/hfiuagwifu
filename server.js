import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as IOServer } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { loadDB, saveDB, transact } from './store.js';
import fs from 'fs-extra';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const app = express();
const TON_USD = 3.5; // 1 TON = 3.5 USD (as requested)
const server = createServer(app);
const io = new IOServer(server, { cors: { origin: process.env.ORIGIN || '*' } });

app.use(cors({ origin: process.env.ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function sign(user){
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'No token' });
  try{
    const payload = jwt.verify(t, JWT_SECRET);
    req.user = payload; next();
  } catch(e){ return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req,res,next){
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function seed(){
  const db = await loadDB();
  if (db.users.length === 0){
    const pass = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.users.push({ id: 'u_admin', name: process.env.ADMIN_NAME || 'Admin', email: process.env.ADMIN_EMAIL || 'admin@example.com', pass: pass, role:'admin', balance: 0, owned: [], gifts: 0 });
    db.users.push({ id: 'u_1001', name: 'Alice', email: 'alice@example.com', pass: await bcrypt.hash('alice123',10), role:'user', balance: 0, owned: [], gifts: 0 });
    db.users.push({ id: 'u_1002', name: 'Bob', email: 'bob@example.com', pass: await bcrypt.hash('bob123',10), role:'user', balance: 0, owned: [], gifts: 0 });
  }
  if (db.items.length === 0){
    // Start with an EMPTY market as requested
  }
  await saveDB(db);
}
await seed();

// ----------------- AUTH -----------------
app.post('/api/auth/register', async (req,res)=>{
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = await loadDB();
  if (db.users.find(u=>u.email.toLowerCase()===String(email).toLowerCase())) return res.status(409).json({ error: 'Email exists' });
  const user = {
    id: nanoid(10),
    name, email,
    pass: await bcrypt.hash(password, 10),
    role: 'user',
    balance: 0,
    owned: [],
    gifts: 0
  };
  db.users.push(user);
  await saveDB(db);
  const token = sign(user);
  const safeUser = { id:user.id, name:user.name, email:user.email, role:user.role, balance:user.balance };
  res.json({ token, user: safeUser });
});

app.post('/api/auth/login', async (req,res)=>{
  const { email, password } = req.body || {};
  const db = await loadDB();
  const user = db.users.find(u=>u.email.toLowerCase()===String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.pass);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = sign(user);
  const safeUser = { id:user.id, name:user.name, email:user.email, role:user.role, balance:user.balance };
  res.json({ token, user: safeUser });
});

// ----------------- MARKET -----------------
app.get('/api/market/items', async (req,res)=>{
  const db = await loadDB();
  res.json(db.items);
});


// ----------------- RATE -----------------
app.get('/api/rate', async (req,res)=>{
  res.json({ tonUsd: TON_USD });
});

// ----------------- NOTIFICATIONS -----------------
app.get('/api/notifications', auth, async (req,res)=>{
  const db = await loadDB();
  const list = (db.notifications || []).filter(n => n.userId === req.user.id).sort((a,b)=>b.ts-a.ts).slice(0,200);
  res.json(list);
});
app.post('/api/notifications/read', auth, async (req,res)=>{
  const { ids=[] } = req.body || {};
  await transact(async db=>{
    (db.notifications = db.notifications || []).forEach(n=>{
      if (n.userId===req.user.id && ids.includes(n.id)) n.read = true;
    });
    await saveDB(db);
    res.json({ ok:true });
  });
});

function pushNotify(db, userId, type, payload){
  db.notifications = db.notifications || [];
  const n = { id: nanoid(12), userId, type, payload, read:false, ts: Date.now() };
  db.notifications.push(n);
  io.to(userId).emit('notify', n);
}

// Attach Socket.IO room per-user on connection (if token provided query? skip for brevity)
// We'll expose a /api/attach-socket to join room after auth on client
app.post('/api/attach-socket', auth, (req,res)=>{
  const sid = req.headers['x-sid'];
  if (!sid) return res.json({ ok:false });
  const sock = io.sockets.sockets.get(sid);
  if (sock) { sock.join(req.user.id); }
  res.json({ ok:true });
});

io.on('connection', (socket)=>{
  // expose socket.id to client for room join
  socket.emit('hello', { sid: socket.id });
});

// ----------------- PAYMENTS -----------------
// Model: db.payments = [{id, userId, kind:'deposit'|'withdraw', amountTon, usd, tonAddress?, status:'pending'|'approved'|'rejected', ts, adminId?, note? }]

app.get('/api/payments/mine', auth, async (req,res)=>{
  const db = await loadDB();
  const list = (db.payments||[]).filter(p=>p.userId===req.user.id).sort((a,b)=>b.ts-a.ts).slice(0,200);
  res.json(list);
});

app.post('/api/payments/deposit/request', auth, async (req,res)=>{
  const { amountTon } = req.body || {};
  const amt = Number(amountTon);
  if (!(amt>0)) return res.status(400).json({ error:'amountTon > 0 required' });
  await transact(async db=>{
    db.payments = db.payments || [];
    const pay = { id:nanoid(12), userId:req.user.id, kind:'deposit', amountTon:amt, usd: +(amt*TON_USD).toFixed(2), status:'pending', ts:Date.now() };
    db.payments.push(pay);
    pushNotify(db, req.user.id, 'deposit_requested', { id: pay.id, amountTon: amt });
    // notify admins (send to admin rooms) — simple broadcast for demo
    io.emit('admin:payments:update', { id: pay.id });
    await saveDB(db);
    res.json({ ok:true, payment: pay });
  });
});

app.post('/api/payments/withdraw/request', auth, async (req,res)=>{
  const { amountTon, tonAddress } = req.body || {};
  const amt = Number(amountTon);
  if (!(amt>0)) return res.status(400).json({ error:'amountTon > 0 required' });
  if (!tonAddress || tonAddress.length < 5) return res.status(400).json({ error:'Valid tonAddress required' });
  await transact(async db=>{
    const me = db.users.find(u=>u.id===req.user.id);
    if (!me) { res.status(404).json({ error:'User not found' }); return; }
    if ((me.balance||0) < amt) { res.status(400).json({ error:'Insufficient balance' }); return; }
    // hold funds by debiting immediately to avoid double spend
    me.balance -= amt;
    db.payments = db.payments || [];
    const pay = { id:nanoid(12), userId:req.user.id, kind:'withdraw', amountTon:amt, usd: +(amt*TON_USD).toFixed(2), tonAddress, status:'pending', ts:Date.now() };
    db.payments.push(pay);
    db.history.push({ userId: req.user.id, t:`Withdrawal requested ${amt} TON to ${tonAddress} (held)`, ts: Date.now() });
    pushNotify(db, req.user.id, 'withdraw_requested', { id: pay.id, amountTon: amt });
    io.emit('admin:payments:update', { id: pay.id });
    await saveDB(db);
    res.json({ ok:true, payment: pay });
  });
});

// Admin view & actions
app.get('/api/admin/payments', auth, adminOnly, async (req,res)=>{
  const db = await loadDB();
  const { status } = req.query;
  let list = db.payments || [];
  if (status) list = list.filter(p=>p.status===status);
  list = list.sort((a,b)=>b.ts-a.ts).slice(0,500);
  res.json(list);
});

app.post('/api/admin/payments/approve', auth, adminOnly, async (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error:'id required' });
  await transact(async db=>{
    const p = (db.payments||[]).find(x=>x.id===id);
    if (!p) { res.status(404).json({ error:'Payment not found' }); return; }
    if (p.status!=='pending') { res.status(400).json({ error:'Already processed' }); return; }
    const user = db.users.find(u=>u.id===p.userId);
    if (!user) { res.status(404).json({ error:'User not found' }); return; }
    if (p.kind==='deposit'){
      user.balance = (user.balance||0) + p.amountTon;
      db.history.push({ userId: user.id, t:`Deposit approved ${p.amountTon} TON (+$${p.usd})`, ts: Date.now() });
    } else if (p.kind==='withdraw'){
      // funds already held; here we'd send on-chain TON. We just mark approved.
      db.history.push({ userId: user.id, t:`Withdrawal approved ${p.amountTon} TON to ${p.tonAddress}`, ts: Date.now() });
    }
    p.status='approved'; p.adminId = req.user.id;
    pushNotify(db, user.id, 'payment_approved', { id: p.id, kind: p.kind, amountTon: p.amountTon });
    await saveDB(db);
    io.emit('admin:payments:update', { id: p.id, status:'approved' });
    res.json({ ok:true, payment: p });
  });
});

app.post('/api/admin/payments/reject', auth, adminOnly, async (req,res)=>{
  const { id, note } = req.body || {};
  if (!id) return res.status(400).json({ error:'id required' });
  await transact(async db=>{
    const p = (db.payments||[]).find(x=>x.id===id);
    if (!p) { res.status(404).json({ error:'Payment not found' }); return; }
    if (p.status!=='pending') { res.status(400).json({ error:'Already processed' }); return; }
    const user = db.users.find(u=>u.id===p.userId);
    if (!user) { res.status(404).json({ error:'User not found' }); return; }
    if (p.kind==='withdraw'){
      // refund held funds
      user.balance = (user.balance||0) + p.amountTon;
      db.history.push({ userId: user.id, t:`Withdrawal rejected ${p.amountTon} TON (refunded)`, ts: Date.now() });
    }
    p.status='rejected'; p.adminId = req.user.id; p.note = note||'';
    pushNotify(db, user.id, 'payment_rejected', { id: p.id, kind: p.kind, amountTon: p.amountTon, note: p.note });
    await saveDB(db);
    io.emit('admin:payments:update', { id: p.id, status:'rejected' });
    res.json({ ok:true, payment: p });
  });
});

// ----------------- ME -----------------
app.get('/api/me', auth, async (req,res)=>{
  const db = await loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  res.json({ id: me.id, name: me.name, email: me.email, role: me.role, balance: me.balance });
});
app.get('/api/me/owned', auth, async (req,res)=>{
  const db = await loadDB();
  const owned = db.items.filter(it=>it.ownerId===req.user.id);
  res.json(owned);
});
app.get('/api/me/history', auth, async (req,res)=>{
  const db = await loadDB();
  const hist = db.history.filter(h=>h.userId===req.user.id).slice(-100).reverse();
  res.json(hist);
});

// ----------------- TX PAY (buy/gift) -----------------
app.post('/api/tx/pay', auth, async (req,res)=>{
  const { itemId, mode, toUserId } = req.body || {};
  if (!itemId || !mode) return res.status(400).json({ error: 'itemId and mode required' });
  await transact(async (db)=>{
    const buyer = db.users.find(u=>u.id===req.user.id);
    const item = db.items.find(x=>x.id===itemId);
    if (!item) { res.status(404).json({ error:'Item not found' }); return; }
    if (item.ownerId) { res.status(400).json({ error:'Already sold' }); return; }
    const price = item.price; // always charge EXACT market price
    if (mode==='buy'){
      if (buyer.balance < price) { res.status(400).json({ error:'Insufficient balance' }); return; }
      buyer.balance -= price;
      item.ownerId = buyer.id;
      buyer.owned.push(item.id);
      db.history.push({ userId: buyer.id, t: `Bought ${item.id} for ${price} TON`, ts: Date.now() });
    } else if (mode==='gift'){
      if (!toUserId) { res.status(400).json({ error:'toUserId required for gift mode' }); return; }
      const recipient = db.users.find(u=>u.id===toUserId);
      if (!recipient) { res.status(404).json({ error:'Recipient not found' }); return; }
      if (buyer.balance < price) { res.status(400).json({ error:'Insufficient balance' }); return; }
      buyer.balance -= price;
      item.ownerId = recipient.id;
      recipient.owned.push(item.id);
      recipient.gifts = (recipient.gifts||0)+1;
      db.history.push({ userId: buyer.id, t: `Gifted ${item.id} to ${recipient.id} for ${price} TON`, ts: Date.now() });
      db.history.push({ userId: recipient.id, t: `Received gift ${item.id} from ${buyer.id}`, ts: Date.now() });
    } else {
      res.status(400).json({ error:'Invalid mode' }); return;
    }
    await saveDB(db);
    io.emit('market:update', { itemId: item.id });
    res.json({ ok:true, message: mode==='gift'?'Gift sent':'Purchased', price });
  });
});

// ----------------- UPGRADE (per-NFT by ID) -----------------
app.post('/api/nft/upgrade', auth, async (req,res)=>{
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error:'id required' });
  await transact(async (db)=>{
    const item = db.items.find(x=>x.id===id);
    if (!item) { res.status(404).json({ error:'Item not found' }); return; }
    if (item.ownerId !== req.user.id) { res.status(403).json({ error:'Not owner' }); return; }
    item.stars = Math.max(0, (item.stars||0)-1);
    item.level = (item.level||0)+1;
    db.history.push({ userId: req.user.id, t: `Upgraded ${item.id} to level ${item.level} (stars ${item.stars})`, ts: Date.now() });
    await saveDB(db);
    io.emit('market:update', { itemId: item.id });
    res.json({ ok:true, message:`Upgraded ${item.id} → level ${item.level}`, item });
  });
});

// ----------------- ADMIN -----------------
app.get('/api/admin/users', auth, adminOnly, async (req,res)=>{
  const db = await loadDB();
  const safe = db.users.map(u=>({ id:u.id, name:u.name, email:u.email, role:u.role, balance:u.balance, gifts:u.gifts||0 }));
  res.json(safe);
});
app.post('/api/admin/gift', auth, adminOnly, async (req,res)=>{
  const { toUserId, itemId } = req.body || {};
  if (!toUserId || !itemId) return res.status(400).json({ error:'toUserId and itemId required' });
  await transact(async (db)=>{
    const user = db.users.find(u=>u.id===toUserId);
    const item = db.items.find(x=>x.id===itemId);
    if (!user) { res.status(404).json({ error:'User not found' }); return; }
    if (!item) { res.status(404).json({ error:'Item not found' }); return; }
    if (item.ownerId) { res.status(400).json({ error:'Already owned' }); return; }
    const price = item.price;
    if (user.balance < price){ res.status(400).json({ error:'Recipient has insufficient balance to be charged' }); return; }
    // Charge the RECIPIENT (per your requirement) at the exact market price
    user.balance -= price;
    item.ownerId = user.id;
    user.owned.push(item.id);
    user.gifts = (user.gifts||0)+1;
    db.history.push({ userId: user.id, t:`Admin issued gift ${item.id} (charged ${price} TON)`, ts: Date.now() });
    await saveDB(db);
    io.emit('market:update', { itemId: item.id });
    res.json({ ok:true, message:`Gifted ${item.id} to ${user.id} and charged ${price} TON` });
  });
});


// ----------------- ADMIN PLUS (v2) -----------------
app.get('/api/admin/summary', auth, adminOnly, async (req,res)=>{
  const db = await loadDB();
  const totalSupply = db.items.length;
  const owned = db.items.filter(i=>i.ownerId).length;
  const users = db.users.length;
  const volume = db.history.filter(h=>/Bought|Gifted|issued gift/i.test(h.t)).length;
  res.json({ users, totalSupply, owned, volume });
});

// USERS
app.post('/api/admin/users/create', auth, adminOnly, async (req,res)=>{
  const { name, email, password, balance=0, role='user' } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error:'name, email, password required' });
  const db = await loadDB();
  if (db.users.find(u=>u.email.toLowerCase()===String(email).toLowerCase())) return res.status(409).json({ error:'Email exists' });
  const pass = await bcrypt.hash(password, 10);
  const user = { id: nanoid(10), name, email, pass, role, balance, owned: [], gifts: 0, banned:false };
  db.users.push(user);
  await saveDB(db);
  res.json({ ok:true, user: { id:user.id, name:user.name, email:user.email, role:user.role, balance:user.balance, banned:user.banned } });
});
app.post('/api/admin/users/balance', auth, adminOnly, async (req,res)=>{
  const { userId, delta } = req.body || {};
  if (!userId || typeof delta !== 'number') return res.status(400).json({ error:'userId and numeric delta required' });
  await transact(async db=>{
    const u = db.users.find(x=>x.id===userId);
    if (!u) { res.status(404).json({ error:'User not found' }); return; }
    u.balance = Math.max(0, (u.balance||0) + delta);
    db.history.push({ userId: userId, t:`Admin balance ${delta>=0? 'credit':'debit'} ${Math.abs(delta)} TON`, ts: Date.now() });
    await saveDB(db);
    res.json({ ok:true, balance: u.balance });
  });
});
app.post('/api/admin/users/ban', auth, adminOnly, async (req,res)=>{
  const { userId, banned } = req.body || {};
  if (!userId || typeof banned !== 'boolean') return res.status(400).json({ error:'userId and banned boolean required' });
  await transact(async db=>{
    const u = db.users.find(x=>x.id===userId);
    if (!u) { res.status(404).json({ error:'User not found' }); return; }
    u.banned = banned;
    await saveDB(db);
    res.json({ ok:true, banned });
  });
});

// ITEMS
app.post('/api/admin/items/create', auth, adminOnly, async (req,res)=>{
  const { name, price, img, collection='Default', rating=5 } = req.body || {};
  if (!name || typeof price!=='number') return res.status(400).json({ error:'name and numeric price required' });
  await transact(async db=>{
    const id = 'nft_'+(1000 + db.items.length);
    const item = { id, name, price, rating, img: img||'https://picsum.photos/seed/'+encodeURIComponent(name)+'/800', collection, stars:3, level:0, ownerId:null, createdAt: Date.now() };
    db.items.push(item);
    await saveDB(db);
    io.emit('market:update', { itemId: id });
    res.json({ ok:true, item });
  });
});
app.post('/api/admin/items/update', auth, adminOnly, async (req,res)=>{
  const { id, ...fields } = req.body || {};
  if (!id) return res.status(400).json({ error:'id required' });
  await transact(async db=>{
    const it = db.items.find(x=>x.id===id);
    if (!it) { res.status(404).json({ error:'Item not found' }); return; }
    Object.assign(it, fields);
    await saveDB(db);
    io.emit('market:update', { itemId: it.id });
    res.json({ ok:true, item: it });
  });
});
app.post('/api/admin/items/delete', auth, adminOnly, async (req,res)=>{
  const { id } = req.body || {};
  await transact(async db=>{
    const idx = db.items.findIndex(x=>x.id===id);
    if (idx===-1) { res.status(404).json({ error:'Item not found' }); return; }
    db.items.splice(idx,1);
    await saveDB(db);
    io.emit('market:update', { itemId: id });
    res.json({ ok:true });
  });
});
app.post('/api/admin/items/clear', auth, adminOnly, async (req,res)=>{
  await transact(async db=>{
    db.items = [];
    await saveDB(db);
    io.emit('market:update', { cleared: true });
    res.json({ ok:true, cleared:true });
  });
});
app.post('/api/admin/items/bulkImport', auth, adminOnly, async (req,res)=>{
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error:'items array required' });
  await transact(async db=>{
    items.forEach((x,idx)=>{
      const id = 'nft_'+(1000 + db.items.length);
      db.items.push({ id, name:x.name||('Item '+id), price:Number(x.price)||0, rating:Number(x.rating)||5, img:x.img||'https://picsum.photos/seed/i'+idx+'/800', collection:x.collection||'Default', stars: x.stars||3, level: x.level||0, ownerId: x.ownerId||null, createdAt: Date.now() });
    });
    await saveDB(db);
    io.emit('market:update', { bulk:true });
    res.json({ ok:true, count: items.length });
  });
});

// TRANSFER & BURN
app.post('/api/admin/transfer', auth, adminOnly, async (req,res)=>{
  const { itemId, toUserId } = req.body || {};
  if (!itemId || !toUserId) return res.status(400).json({ error:'itemId and toUserId required' });
  await transact(async db=>{
    const it = db.items.find(x=>x.id===itemId);
    const to = db.users.find(u=>u.id===toUserId);
    if (!it) { res.status(404).json({ error:'Item not found' }); return; }
    if (!to) { res.status(404).json({ error:'Target user not found' }); return; }
    // Remove from previous owner if any
    if (it.ownerId){
      const prev = db.users.find(u=>u.id===it.ownerId);
      if (prev) prev.owned = (prev.owned||[]).filter(id=>id!==it.id);
    }
    it.ownerId = to.id;
    to.owned = to.owned || [];
    if (!to.owned.includes(it.id)) to.owned.push(it.id);
    db.history.push({ userId: to.id, t:`Admin transferred ${it.id} to ${to.id}`, ts: Date.now() });
    await saveDB(db);
    io.emit('market:update', { itemId: it.id });
    res.json({ ok:true });
  });
});
app.post('/api/admin/burn', auth, adminOnly, async (req,res)=>{
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error:'itemId required' });
  await transact(async db=>{
    const it = db.items.find(x=>x.id===itemId);
    if (!it) { res.status(404).json({ error:'Item not found' }); return; }
    // Remove from owner's list
    if (it.ownerId){
      const owner = db.users.find(u=>u.id===it.ownerId);
      if (owner) owner.owned = (owner.owned||[]).filter(id=>id!==it.id);
    }
    // Remove item entirely
    db.items = db.items.filter(x=>x.id!==it.id);
    db.history.push({ userId: it.ownerId || 'system', t:`Admin burned ${it.id}`, ts: Date.now() });
    await saveDB(db);
    io.emit('market:update', { burned: it.id });
    res.json({ ok:true, burned: it.id });
  });
});

// HISTORY & DB
app.get('/api/admin/history', auth, adminOnly, async (req,res)=>{
  const { userId, limit=200 } = req.query;
  const db = await loadDB();
  let hist = db.history;
  if (userId) hist = hist.filter(h=>h.userId===userId);
  hist = hist.sort((a,b)=>b.ts-a.ts).slice(0, Math.min(1000, Number(limit)||200));
  res.json(hist);
});
app.get('/api/admin/db/export', auth, adminOnly, async (req,res)=>{
  const db = await loadDB();
  res.json(db);
});
app.post('/api/admin/db/import', auth, adminOnly, async (req,res)=>{
  const { db } = req.body || {};
  if (!db || !db.users || !db.items || !db.history) return res.status(400).json({ error:'db with users, items, history required' });
  await saveDB(db);
  io.emit('market:update', { imported:true });
  res.json({ ok:true });
});

// --------------- START ---------------
server.listen(PORT, ()=>{
  console.log('GiftNFT server running on http://localhost:'+PORT);
});
